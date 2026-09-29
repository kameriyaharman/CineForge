# CineForge

Cinematic AI video studio — Next.js 15 (App Router), Prisma 7 + PostgreSQL, Fal.ai Hunyuan Video, Magnific upscaling.

## Deploy on Railway

1. Create a project with a **PostgreSQL** service and a service from this repo.
2. Set variables on the app service (see `.env.example`):
   - `DATABASE_URL` → `${{Postgres.DATABASE_URL}}`
   - `FAL_KEY`, `SESSION_SECRET`, `OWNER_ACCESS_KEY` (16+ chars), `NEXT_PUBLIC_CINEFORGE_USER_ID` (any UUID)
   - optional: `MAGNIFIC_API_KEY`, `OWNER_EMAIL`
3. Deploy. `npm start` runs `prisma db push` (creates/updates tables) then `next start`.
4. Open the site → `/login` → enter `OWNER_ACCESS_KEY`.

`NEXT_PUBLIC_*` values are baked in at build time: redeploy after changing them.

## Local

```bash
cp .env.example .env   # fill in values
npm install
npm run db:push
npm run dev
```

## Status

- Soul ID characters are stored and selectable; face consistency (IP-Adapter-FaceID → image-to-video) is not wired yet — see Step A in `app/api/generate-video/route.ts`.
- Login is an interim single-owner access key (`/login`); replace with real auth before adding other users.
- Switch from `prisma db push` to `prisma migrate` once the schema stabilises.
