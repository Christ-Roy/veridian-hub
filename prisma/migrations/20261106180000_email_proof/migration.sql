-- Sessions JWT émises avant cette date : invalides (usurpation annulée par une
-- preuve OAuth). Les sessions du Hub sont des JWT de 90 jours, irrévocables sinon.
ALTER TABLE "hub_app"."users" ADD COLUMN "sessions_valid_after" TIMESTAMP(3);

-- Auth.js laisse email_verified à null en OAuth alors que Google a prouvé
-- l'adresse. Rattrapage limité aux comptes Google sans mot de passe : mesuré le
-- 06/11/2026, leurs id_token portent email_verified=true sur la même adresse.
-- Un compte qui a aussi un mot de passe se règle à sa prochaine connexion Google.
UPDATE "hub_app"."users" u
SET "email_verified" = CURRENT_TIMESTAMP
WHERE u."email_verified" IS NULL
  AND EXISTS (
    SELECT 1 FROM "hub_app"."accounts" a
    WHERE a."user_id" = u."id"
      AND a."provider" = 'google'
      AND a."id_token" IS NOT NULL
      AND (
        convert_from(
          decode(
            rpad(
              translate(split_part(a."id_token", '.', 2), '-_', '+/'),
              (length(split_part(a."id_token", '.', 2)) + 3) / 4 * 4,
              '='
            ),
            'base64'
          ),
          'utf8'
        )::json
      )->>'email' = u."email"
      AND (
        convert_from(
          decode(
            rpad(
              translate(split_part(a."id_token", '.', 2), '-_', '+/'),
              (length(split_part(a."id_token", '.', 2)) + 3) / 4 * 4,
              '='
            ),
            'base64'
          ),
          'utf8'
        )::json
      )->>'email_verified' = 'true'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "hub_app"."accounts" a
    WHERE a."user_id" = u."id" AND a."provider" = 'credentials'
  );
