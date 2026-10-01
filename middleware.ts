import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends visitors without a session cookie to /login. This is only a UX
 * redirect — every API route still verifies the signed token itself.
 * Skipped when SESSION_SECRET is unset (local development).
 */
export function middleware(req: NextRequest) {
  if (!process.env.SESSION_SECRET) return NextResponse.next();
  if (req.cookies.get("cf_session")?.value) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/", "/images", "/edit", "/soul-id", "/library"],
};
