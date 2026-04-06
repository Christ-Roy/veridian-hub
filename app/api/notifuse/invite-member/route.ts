import { createClient } from '@/utils/supabase/server';
import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';

const NOTIFUSE_API_URL = process.env.NOTIFUSE_API_URL!;
const NOTIFUSE_ROOT_EMAIL = process.env.NOTIFUSE_ROOT_EMAIL!;
const NOTIFUSE_SECRET_KEY = process.env.NOTIFUSE_SECRET_KEY!;

function generateHmacSignature(email: string, timestamp: number, secretKey: string): string {
  const message = `${email}:${timestamp}`;
  return createHmac('sha256', secretKey).update(message).digest('hex');
}

export async function POST(request: Request) {
  try {
    // Vérifier auth
    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Récupérer le tenant de l'utilisateur
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('notifuse_workspace_slug, notifuse_user_email')
      .eq('user_id', user.id)
      .maybeSingle<{
        notifuse_workspace_slug: string | null;
        notifuse_user_email: string | null;
      }>();

    if (tenantError || !tenant?.notifuse_workspace_slug) {
      return NextResponse.json({ error: 'Notifuse workspace not found' }, { status: 404 });
    }

    const workspaceId = tenant.notifuse_workspace_slug;
    const email = tenant.notifuse_user_email || user.email!;

    // Auth root Notifuse
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = generateHmacSignature(NOTIFUSE_ROOT_EMAIL, timestamp, NOTIFUSE_SECRET_KEY);

    const authResponse = await fetch(`${NOTIFUSE_API_URL}/api/user.rootSignin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: NOTIFUSE_ROOT_EMAIL,
        timestamp,
        signature,
      }),
    });

    const authData = await authResponse.json();
    if (!authData.token) {
      return NextResponse.json({ error: 'Failed to authenticate with Notifuse' }, { status: 500 });
    }

    // Inviter le membre avec TOUS les droits (comme le script)
    const inviteResponse = await fetch(`${NOTIFUSE_API_URL}/api/workspaces.inviteMember`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authData.token}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        email: email,
        permissions: {
          contacts: { read: true, write: true },
          lists: { read: true, write: true },
          templates: { read: true, write: true },
          broadcasts: { read: true, write: true },
          transactional: { read: true, write: true },
          workspace: { read: true, write: true },
          message_history: { read: true, write: true },
          blog: { read: true, write: true },
          automations: { read: true, write: true },
          llm: { read: true, write: true },
        },
      }),
    });

    const inviteData = await inviteResponse.json();

    if (inviteData.error) {
      // Si erreur "déjà membre", c'est OK
      if (inviteData.error.includes('already') || inviteData.error.includes('member')) {
        return NextResponse.json({
          success: true,
          message: 'You are already a member of this workspace',
          alreadyMember: true,
        });
      }
      return NextResponse.json({ error: inviteData.error }, { status: 400 });
    }

    // Marquer l'invitation comme envoyée
    await (supabase
      .from('tenants') as any)
      .update({ notifuse_invitation_sent_at: new Date().toISOString() })
      .eq('user_id', user.id);

    return NextResponse.json({
      success: true,
      message: 'Invitation sent! Check your email to accept.',
      email,
    });

  } catch (error: any) {
    console.error('[Invite Member API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
