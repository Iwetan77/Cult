export async function GET(request: Request) {
  const code = request.headers.get('x-vercel-ip-country')?.toUpperCase() ?? null;
  return Response.json({ country: code && /^[A-Z]{2}$/.test(code) ? code : null });
}
