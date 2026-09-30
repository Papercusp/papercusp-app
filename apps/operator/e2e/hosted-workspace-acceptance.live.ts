/**
 * Real P-031 browser session slice. Provider lifecycle/teardown and native Tauri
 * acceptance remain separate evidence. The .live.ts suffix excludes this test
 * from the default UI suite; the explicit profile never provisions a host.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { expect, test } from "./_egress";
import { readHostedHttp1AcceptanceConfig } from "./_hosted-http1-config";

const acceptance = readHostedHttp1AcceptanceConfig();
test.use({ egressAllowedOrigins: [acceptance.origin] });

function required(name: string): string {
  const value = process.env[`PAPERCUSP_HOSTED_ACCEPTANCE_${name}`]?.trim();
  if (!value)
    throw new Error(`PAPERCUSP_HOSTED_ACCEPTANCE_${name} is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

type DesktopEntry = { desktopSessionId: string; displayNumber?: number };

test("real hosted workspace PTY, files, resume and desktop watch/takeover", async ({
  page,
}, testInfo) => {
  const hostId = required("HOST_ID");
  const workspaceId = required("WORKSPACE_ID");
  const workspaceRoot = required("WORKSPACE_ROOT");
  const desktopId = required("DESKTOP_SESSION_ID");
  expect(posix.isAbsolute(workspaceRoot)).toBe(true);
  expect(posix.normalize(workspaceRoot)).not.toBe("/");
  expect(workspaceRoot).not.toMatch(/[\r\n\0]/);

  const nonce = randomUUID();
  const filename = `.papercusp-p031-${nonce}.txt`;
  const content = `P-031 file round trip ${nonce}\n`;
  const absoluteFile = posix.join(workspaceRoot, filename);
  const evidence: Record<string, unknown> = {
    contract: "P-031 hosted workspace session v1",
    origin: acceptance.origin,
    hostId,
    workspaceId,
    desktopId,
    startedAt: new Date().toISOString(),
  };
  let terminalOutput = "";
  let desktopBytes = 0;
  let roster: DesktopEntry[] = [];
  const ready: Array<{ resumed: boolean; role: string }> = [];
  const desktopGrants: Array<{ action: string; inputAllowed: boolean }> = [];

  // Observe real frames without retaining ticket URLs, file contents, screen
  // pixels or unrelated terminal output in the receipt.
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/api/hosted/connectors/socket")
      return;
    socket.on("framereceived", ({ payload }) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(payload.toString());
      } catch {
        return;
      }
      if (message.type === "pty.output" && typeof message.data === "string") {
        terminalOutput = (
          terminalOutput + Buffer.from(message.data, "base64").toString("utf8")
        ).slice(-32_768);
      } else if (message.type === "pty.ready") {
        ready.push({
          resumed: message.resumed === true,
          role: String(message.role),
        });
      } else if (
        message.type === "desktop.roster.result" &&
        Array.isArray(message.desktops)
      ) {
        roster = message.desktops.filter(
          (entry): entry is DesktopEntry =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.desktopSessionId === "string",
        );
      } else if (message.type === "desktop.ready") {
        desktopGrants.push({
          action: String(message.action),
          inputAllowed: message.inputAllowed === true,
        });
      } else if (
        message.type === "desktop.data" &&
        typeof message.data === "string"
      ) {
        desktopBytes += Buffer.byteLength(message.data, "base64");
      }
    });
  });

  const session = page.getByRole("region", {
    name: /^Browser workspace session for /,
  });
  const pty = session.locator("textarea.xterm-helper-textarea");
  const run = async (command: string, marker: string) => {
    terminalOutput = "";
    await pty.focus();
    await page.keyboard.insertText(command);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => terminalOutput.includes(marker), { timeout: 20_000 })
      .toBe(true);
  };
  // Expected markers do not occur contiguously in the command: echo is not proof
  // of execution. printf must assemble the marker inside the guest shell.
  const emit = (tag: string) =>
    `printf 'P031_${tag}_%s\\n' ${shellQuote(nonce)}`;
  const marker = (tag: string) => `P031_${tag}_${nonce}`;
  let uploadAttempted = false;
  let connected = false;

  try {
    const query = new URLSearchParams({
      step: "operate",
      host: hostId,
      tab: "desktops",
    });
    const response = await page.goto(`/cloud-workspaces?${query}`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);
    const auth = await page.evaluate(async () => {
      const response = await fetch("/api/hosted/auth/session", {
        cache: "no-store",
      });
      const body = await response.json();
      return {
        status: response.status,
        workspaceId: body.session?.workspaceId,
      };
    });
    expect(auth).toEqual({ status: 200, workspaceId });
    await expect(session).toHaveCount(1);
    await expect(session).toBeVisible();
    await session.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.poll(() => ready.length, { timeout: 30_000 }).toBe(1);
    expect(ready[0]).toEqual({ resumed: false, role: "controller" });
    connected = true;
    await run(
      `P031_STATE=${shellQuote(nonce)}; ${emit("EXEC")}`,
      marker("EXEC"),
    );
    evidence.ptyExecuted = true;

    await session
      .getByRole("textbox", { name: "Workspace file path" })
      .fill(".");
    await session.getByRole("button", { name: "List", exact: true }).click();
    await expect(session).toContainText(/Listed \d+ entries in \./);
    uploadAttempted = true;
    await session.getByLabel("Upload workspace file").setInputFiles({
      name: filename,
      mimeType: "text/plain",
      buffer: Buffer.from(content),
    });
    await session
      .getByRole("button", { name: `· ${filename}`, exact: true })
      .click();
    await expect(session.locator("pre")).toHaveText(content);
    await run(
      `test -f ${shellQuote(absoluteFile)} && grep -Fxq -- ${shellQuote(content.trim())} ${shellQuote(absoluteFile)} && ${emit("GUEST_FILE")}`,
      marker("GUEST_FILE"),
    );
    await session
      .getByRole("textbox", { name: "Workspace file path" })
      .fill(filename);
    const downloaded = page.waitForEvent("download");
    await session
      .getByRole("button", { name: "Download", exact: true })
      .click();
    const stream = await (await downloaded).createReadStream();
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe(content);
    evidence.fileRoundTrip = true;

    await session.getByRole("button", { name: "Detach", exact: true }).click();
    connected = false;
    await session
      .getByRole("button", { name: "Reconnect", exact: true })
      .click();
    await expect.poll(() => ready.length, { timeout: 30_000 }).toBe(2);
    expect(ready[1]).toEqual({ resumed: true, role: "controller" });
    connected = true;
    await run("printf 'P031_STATE_%s\\n' \"$P031_STATE\"", marker("STATE"));
    evidence.ptyResumedWithState = true;

    await expect
      .poll(
        () => roster.some((entry) => entry.desktopSessionId === desktopId),
        { timeout: 20_000 },
      )
      .toBe(true);
    const desktop = roster.find(
      (entry) => entry.desktopSessionId === desktopId,
    )!;
    const label =
      desktop.displayNumber === undefined
        ? desktopId
        : `Display ${desktop.displayNumber}`;
    const watch = page.getByRole("button", {
      name: `Watch ${label}`,
      exact: true,
    });
    await expect(watch).toHaveCount(1);
    await watch.click();
    const viewer = page.getByRole("region", {
      name: `Desktop viewer for ${label}`,
      exact: true,
    });
    const assertViewer = async (inputAllowed: boolean) => {
      await expect(viewer).toHaveAttribute("data-state", "connected", {
        timeout: 30_000,
      });
      await expect(viewer).toHaveAttribute(
        "data-input-allowed",
        String(inputAllowed),
      );
      await expect
        .poll(
          () =>
            viewer
              .locator("canvas")
              .evaluateAll((canvases) =>
                canvases.some(
                  (canvas) =>
                    (canvas as HTMLCanvasElement).width > 0 &&
                    (canvas as HTMLCanvasElement).height > 0,
                ),
              ),
          { timeout: 15_000 },
        )
        .toBe(true);
    };
    await assertViewer(false);
    await expect
      .poll(() => desktopBytes, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(desktopGrants.at(-1)).toEqual({
      action: "watch",
      inputAllowed: false,
    });
    evidence.desktopWatch = {
      connected: true,
      bytesReceived: desktopBytes,
      inputAllowed: false,
    };
    await page
      .getByRole("button", { name: "Close desktop viewer", exact: true })
      .click();

    const bytesBeforeTakeover = desktopBytes;
    await page
      .getByRole("button", { name: `Take over ${label}`, exact: true })
      .click();
    await assertViewer(true);
    await expect
      .poll(() => desktopBytes, { timeout: 15_000 })
      .toBeGreaterThan(bytesBeforeTakeover);
    expect(desktopGrants.at(-1)).toEqual({
      action: "takeover",
      inputAllowed: true,
    });
    evidence.desktopTakeover = { connected: true, inputAllowed: true };
    await page
      .getByRole("button", { name: "Close desktop viewer", exact: true })
      .click();
    await run(emit("AFTER_DESKTOP"), marker("AFTER_DESKTOP"));
    evidence.ptyUnaffectedByDesktop = true;
  } finally {
    try {
      evidence.fixtureRemoved = !uploadAttempted;
      if (uploadAttempted) evidence.fixtureRequiresCleanup = absoluteFile;
      if (uploadAttempted && connected) {
        // Remove only this run's unpredictable, explicitly named test artifact.
        await run(
          `rm -f -- ${shellQuote(absoluteFile)} && test ! -e ${shellQuote(absoluteFile)} && ${emit("CLEAN")}`,
          marker("CLEAN"),
        );
        await session
          .getByRole("textbox", { name: "Workspace file path" })
          .fill(".");
        await session
          .getByRole("button", { name: "List", exact: true })
          .click();
        await expect(
          session.getByRole("button", { name: `· ${filename}`, exact: true }),
        ).toHaveCount(0);
        evidence.fixtureRemoved = true;
        delete evidence.fixtureRequiresCleanup;
      }
      if (connected)
        await session
          .getByRole("button", { name: "Detach", exact: true })
          .click();
    } finally {
      evidence.completedAt = new Date().toISOString();
      await testInfo.attach("hosted-workspace-session-receipt", {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
      });
    }
  }
});
