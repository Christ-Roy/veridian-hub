CREATE TABLE IF NOT EXISTS "hub_app"."user_onboarding" (
    "user_id" TEXT NOT NULL,
    "invited_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "first_app_started_at" TIMESTAMPTZ(6),
    "member_invited_at" TIMESTAMPTZ(6),
    "workspace_renamed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_onboarding_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "hub_app"."user_onboarding"
    ADD CONSTRAINT "user_onboarding_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "hub_app"."users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "user_onboarding_invited_at_idx"
    ON "hub_app"."user_onboarding" ("invited_at");

CREATE INDEX IF NOT EXISTS "user_onboarding_activated_at_idx"
    ON "hub_app"."user_onboarding" ("activated_at");

CREATE INDEX IF NOT EXISTS "user_onboarding_completed_at_idx"
    ON "hub_app"."user_onboarding" ("completed_at");

INSERT INTO "hub_app"."user_onboarding" (
    "user_id",
    "activated_at",
    "first_app_started_at",
    "metadata"
)
SELECT
    u."id",
    CASE
        WHEN EXISTS (
            SELECT 1
            FROM "hub_app"."accounts" a
            WHERE a."user_id" = u."id"
        )
        THEN COALESCE(u."email_verified", u."created_at")
        ELSE NULL
    END AS "activated_at",
    (
        SELECT MIN(v)
        FROM (
            VALUES
                (t."prospection_provisioned_at"),
                (CASE WHEN t."notifuse_workspace_slug" IS NOT NULL THEN t."provisioned_at" ELSE NULL END)
        ) AS started(v)
        WHERE v IS NOT NULL
    ) AS "first_app_started_at",
    jsonb_strip_nulls(jsonb_build_object(
        'backfill', true,
        'backfilledAt', now(),
        'apps', jsonb_build_array(
            CASE WHEN t."notifuse_workspace_slug" IS NOT NULL THEN 'notifuse' ELSE NULL END,
            CASE WHEN t."prospection_provisioned_at" IS NOT NULL THEN 'prospection' ELSE NULL END
        )
    )) AS "metadata"
FROM "hub_app"."users" u
LEFT JOIN LATERAL (
    SELECT *
    FROM "hub_app"."tenants" t
    WHERE t."user_id" = CASE
        WHEN u."supabase_user_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN u."supabase_user_id"::uuid
        ELSE NULL
    END
    ORDER BY t."created_at" ASC
    LIMIT 1
) t ON u."supabase_user_id" IS NOT NULL
ON CONFLICT ("user_id") DO NOTHING;
