-- Store only a hash of invitation tokens. Existing tokens are hashed in place,
-- so any links already sent keep working (the server hashes the token from
-- the link and looks that up).
ALTER TABLE "Invitation" RENAME COLUMN "token" TO "tokenHash";
UPDATE "Invitation" SET "tokenHash" = encode(sha256(convert_to("tokenHash", 'UTF8')), 'hex');
ALTER INDEX "Invitation_token_key" RENAME TO "Invitation_tokenHash_key";
