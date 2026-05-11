import { z } from 'zod';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { Redis } from '@upstash/redis';
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

  const authOptions = {
    credentials: {
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      type: 'authorized_user' as const,
    },
  };

  return {
    data: new BetaAnalyticsDataClient(authOptions),
    admin: new AnalyticsAdminServiceClient(authOptions),
  };
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      'list_properties',
      'Lists GA4 properties YOU have access to. Pass user=<your-email>.',
      { user: z.string().describe('Your teammate identifier (usually email).') },
      async ({ user }) => {
        try {
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
        } catch (err: any) {
          console.error('list_properties failed:', err);
          return {
            content: [{ type: 'text', text: `ERROR: ${err?.message || JSON.stringify(err)}\n\nSTACK: ${err?.stack || 'none'}` }],
            isError: true,
          };
        }
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
        try {
          const { data } = await clientsForUser(user);
          const [resp] = await data.runReport({
            property: `properties/${propertyId}`,
            dateRanges: [{ startDate, endDate }],
            metrics: metrics.map((name) => ({ name })),
            dimensions: (dimensions || []).map((name) => ({ name })),
            limit,
          });
          return { content: [{ type: 'text', text: JSON.stringify(resp, null, 2) }] };
        } catch (err: any) {
          console.error('run_report failed:', err);
          return {
            content: [{ type: 'text', text: `ERROR: ${err?.message || JSON.stringify(err)}\n\nSTACK: ${err?.stack || 'none'}` }],
            isError: true,
          };
        }
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
