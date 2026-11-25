-- Plusieurs adresses par personne (VER-227 S1b). Tables neuves ; `users` garde son contenu et gagne un contrôle à l'écriture de son adresse.
CREATE TABLE IF NOT EXISTS "hub_app"."user_emails" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "preuve" TEXT NOT NULL,
  "prouvee_le" TIMESTAMP(3) NOT NULL,
  "detachee_le" TIMESTAMP(3),
  "detachee_par" TEXT,
  CONSTRAINT "user_emails_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "hub_app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE UNIQUE INDEX IF NOT EXISTS "user_emails_active_key" ON "hub_app"."user_emails"("email") WHERE "detachee_le" IS NULL;
-- @safe: index sur table créée dans la même migration (vide) — lock instantané
CREATE INDEX IF NOT EXISTS "user_emails_user_id_idx" ON "hub_app"."user_emails"("user_id");
CREATE TABLE IF NOT EXISTS "hub_app"."user_email_codes" (
  "user_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "code_empreinte" TEXT NOT NULL,
  "essais" INTEGER NOT NULL DEFAULT 0,
  "expire_le" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_email_codes_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_email_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "hub_app"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Une adresse active n'appartient qu'à une personne, principale ou secondaire : tenu ici pour TOUS les chemins (inscription, OAuth, One Tap,
-- fédération, admin, réglages), présents et à venir. Même code d'erreur qu'un doublon.
CREATE OR REPLACE FUNCTION "hub_app"."adresse_principale_libre"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "hub_app"."user_emails" e WHERE e."email" = lower(NEW."email") AND e."detachee_le" IS NULL AND e."user_id" <> NEW."id") THEN
    RAISE EXCEPTION 'adresse_secondaire_active' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "adresse_principale_libre" ON "hub_app"."users";
CREATE TRIGGER "adresse_principale_libre" BEFORE INSERT OR UPDATE OF "email" ON "hub_app"."users" FOR EACH ROW EXECUTE FUNCTION "hub_app"."adresse_principale_libre"();

CREATE OR REPLACE FUNCTION "hub_app"."adresse_secondaire_libre"() RETURNS trigger AS $$
BEGIN
  IF NEW."detachee_le" IS NULL AND EXISTS (SELECT 1 FROM "hub_app"."users" u WHERE lower(u."email") = NEW."email") THEN
    RAISE EXCEPTION 'adresse_principale_active' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "adresse_secondaire_libre" ON "hub_app"."user_emails";
CREATE TRIGGER "adresse_secondaire_libre" BEFORE INSERT OR UPDATE OF "email", "detachee_le" ON "hub_app"."user_emails" FOR EACH ROW EXECUTE FUNCTION "hub_app"."adresse_secondaire_libre"();
