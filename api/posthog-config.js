// Public browser configuration for the static PostHog loader.
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.POSTHOG_PROJECT_TOKEN;
  const host = process.env.POSTHOG_HOST;
  const missingVariable = !key ? 'POSTHOG_PROJECT_TOKEN' : (!host ? 'POSTHOG_HOST' : null);

  if (missingVariable) {
    const message = `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`;
    if (process.env.NODE_ENV !== 'production') console.warn(message);
    return res.status(200).json({ configured: false, missingVariable, development: process.env.NODE_ENV !== 'production' });
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ configured: true, key, host });
}
