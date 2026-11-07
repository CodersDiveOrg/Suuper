-- Login challenges double as password-reset challenges; a code only works for its own purpose.
ALTER TABLE "LoginChallenge" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'login';
