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
    fallback: 'rest' as const, // use HTTP+JSON instead of gRPC for serverless compatibility
  };

  return {
    data: new BetaAnalyticsDataClient(authOptions),
    admin: new AnalyticsAdminServiceClient(authOptions),
  };
}

function describeError(err: any): string {
  const parts: string[] = [];
  parts.push(`message: ${err?.message ?? '(none)'}`);
  if (err?.code !== undefined) parts.push(`code: ${err.code}`);
  if (err?.details) parts.push(`details: ${err.details}`);
  if (err?.statusDetails) parts.push(`statusDetails: ${JSON.stringify(err.statusDetails)}`);
  if (err?.reason) parts.push(`reason: ${err.reason}`);
  if (err?.domain) parts.push(`domain: ${err.domain}`);
  if (err?.errors) {
    try { parts.push(`errors: ${JSON.stringify(err.errors)}`); } catch {}
  }
  if (err?.response?.data) {
    try { parts.push(`response.data: ${JSON.stringify(err.response.data)}`); } catch {}
  }
  try {
    parts.push(`raw keys: ${Object.keys(err || {}).join(', ')}`);
    parts.push(`raw: ${JSON.stringify(err, Object.getOwnPropertyNames(err)).slice(0, 2000)}`);
  } catch {}
  return parts.join('\n');
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
            content: [{ type: 'text', text: `LIST_PROPERTIES ERROR\n${describeError(err)}` }],
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
            content: [{ type: 'text', text: `RUN_REPORT ERROR\n${describeError(err)}` }],
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
