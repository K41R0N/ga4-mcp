import { z } from 'zod';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { Redis } from '@upstash/redis';
import { OAuth2Client } from 'google-auth-library';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { AnalyticsAdminServiceClient } from '@google-analytics/admin';

const redis = Redis.fromEnv();

async function clientsForUser(user: string) {
  const refreshToken = await redis.get<string>(`google_refresh:${user}`);
  if (!refreshToken) {
    throw new Error(
      `User "${user}" is not connected to Google. Visit ${process.env.GOOGLE_REDIRECT_URI!.replace('/callback', '/start')}?user=${encodeURIComponent(user)}`,
    );
  }
  const auth = new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  });
  auth.setCredentials({ refresh_token: refreshToken });
  return {
    data: new BetaAnalyticsDataClient({ authClient: auth as any }),
    admin: new AnalyticsAdminServiceClient({ authClient: auth as any }),
  };
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      'list_properties',
      'Lists GA4 properties YOU have access to. Pass user=<your-email>.',
      { user: z.string().describe('Your teammate identifier (usually email).') },
      async ({ user }) => {
        const { admin } = await clientsForUser(user);
        const [accounts] = await admin.listAccountSummaries({});
        const out = accounts.flatMap((a) =>
          (a.propertySummaries || []).map((p) => ({
            account: a.displayName,
            property: p.displayName,
            propertyId: p.property?.replace('properties/', ''),
          })),
        );
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      },
    );

    server.tool(
      'run_report',
      'Runs a GA4 report as the specified user.',
      {
        user: z.string(),
        propertyId: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        metrics: z.array(z.string()),
        dimensions: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(10000).optional().default(100),
      },
      async ({ user, propertyId, startDate, endDate, metrics, dimensions, limit }) => {
        const { data } = await clientsForUser(user);
        const [resp] = await data.runReport({
          property: `properties/${propertyId}`,
          dateRanges: [{ startDate, endDate }],
          metrics: metrics.map((name) => ({ name })),
          dimensions: (dimensions || []).map((name) => ({ name })),
          limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
      },
    );
  },
  {},
  { basePath: '/api' },
);

const verifyToken = async (_req: Request, token?: string) => {
  if (!token || token !== process.env.MCP_BEARER_TOKEN) return undefined;
  return {
    token,
    scopes: ['ga4:read'],
    clientId: 'claude',
    extra: {},
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });
export { authHandler as GET, authHandler as POST, authHandler as DELETE };
