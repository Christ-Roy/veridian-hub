'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useState } from 'react';

/**
 * PasswordForm — Auth.js v5
 *
 * POST vers /api/account/password (route protégée par requireUser()).
 * Le hash est stocké dans `Account.access_token` pour le provider 'credentials'.
 */
export default function PasswordForm() {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Échec de la mise à jour du mot de passe');
        return;
      }

      setSuccess(true);
      setNewPassword('');
      setConfirmPassword('');

      setTimeout(() => setSuccess(false), 5000);
    } catch (err: any) {
      setError(err?.message || 'Une erreur inattendue est survenue');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20">
          <p className="text-sm text-destructive font-medium">{error}</p>
        </div>
      )}

      {success && (
        <div className="p-4 rounded-md bg-green-500/10 border border-green-500/20">
          <p className="text-sm text-green-600 dark:text-green-400 font-medium">
            Mot de passe mis à jour.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="new-password">Nouveau mot de passe</Label>
        <Input
          id="new-password"
          type="password"
          placeholder="Saisir le nouveau mot de passe"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={6}
          disabled={isSubmitting}
        />
        <p className="text-xs text-muted-foreground">
          Au moins 6 caractères
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirmer le nouveau mot de passe</Label>
        <Input
          id="confirm-password"
          type="password"
          placeholder="Confirmer le nouveau mot de passe"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={6}
          disabled={isSubmitting}
        />
      </div>

      <Button
        type="submit"
        disabled={isSubmitting || !newPassword || !confirmPassword}
        className="w-full"
      >
        {isSubmitting ? 'Mise à jour...' : 'Mettre à jour le mot de passe'}
      </Button>
    </form>
  );
}
