"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
async function readConfig(ctx) {
    const { promises: fs } = await Promise.resolve().then(() => __importStar(require('node:fs')));
    const { join } = await Promise.resolve().then(() => __importStar(require('node:path')));
    try {
        return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
const plugin = {
    kind: 'plugin',
    name: '@papercupai/notion-export',
    version: '0.1.0',
    papercusp: '^0.1.0',
    description: 'Export mission summary to a Notion database.',
    capabilities: [
        'secrets:read:NOTION_API_KEY',
        'http:fetch:api.notion.com',
        'events:listen:mission-done',
    ],
    actions: [
        {
            name: 'exportMission',
            label: 'Export to Notion',
            surfaces: ['mission-done', 'harness-toolbar'],
            capabilities: ['secrets:read:NOTION_API_KEY', 'http:fetch:api.notion.com'],
            serverHandler: { timeoutSec: 30 },
        },
    ],
    async init(ctx) {
        ctx.actions.register('exportMission', async (innerCtx, params, signal) => {
            return runExportMission(innerCtx, (params ?? {}), signal);
        });
    },
    hooks: {
        async afterDone(ctx) {
            const cfg = await readConfig(ctx);
            if (!cfg.databaseId) {
                ctx.log('notion-export: afterDone — skipped (databaseId not configured)');
                return;
            }
            if (!process.env.NOTION_API_KEY) {
                ctx.log('notion-export: afterDone — skipped (NOTION_API_KEY not configured)');
                return;
            }
            try {
                const r = await runExportMission(ctx, {}, undefined);
                if (r.ok) {
                    ctx.log(`notion-export: afterDone exported → ${r.result?.url ?? '(no url)'}`);
                }
                else {
                    ctx.log(`notion-export: afterDone failed — ${r.error}`);
                }
            }
            catch (e) {
                ctx.log(`notion-export: afterDone threw — ${e?.message ?? String(e)}`);
            }
        },
    },
};
async function runExportMission(ctx, p, signal) {
    const cfg = await readConfig(ctx);
    if (!cfg.databaseId) {
        return { ok: false, error: 'notion-export: databaseId not configured (run `papercusp plugin enable`)' };
    }
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
        return { ok: false, error: 'notion-export: NOTION_API_KEY not set in substrate process env' };
    }
    const title = p.title ?? `Mission @ ${ctx.installSlug} — ${new Date().toISOString().slice(0, 19)}`;
    const summary = p.summary ?? '(no summary provided)';
    const body = {
        parent: { database_id: cfg.databaseId },
        properties: {
            Name: { title: [{ text: { content: title } }] },
        },
        children: [
            {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: summary.slice(0, 2000) } }],
                },
            },
        ],
    };
    try {
        const r = await fetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
                'notion-version': cfg.version ?? '2022-06-28',
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            return { ok: false, error: `notion-export: HTTP ${r.status}${text ? ' — ' + text.slice(0, 200) : ''}` };
        }
        const j = (await r.json());
        return { ok: true, result: { pageId: j.id ?? null, url: j.url ?? null } };
    }
    catch (e) {
        if (e?.name === 'AbortError')
            return { ok: false, error: 'notion-export: aborted (timeout)' };
        return { ok: false, error: e?.message ?? String(e) };
    }
}
exports.default = plugin;
