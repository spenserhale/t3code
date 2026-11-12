/** One CDP command, sent through Playwright or Electron. */
type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const NAVIGATION_TYPE = `performance.getEntriesByType("navigation")[0]?.type ?? ""`;

/**
 * Whether a tab's main document may show a filled password or code. `filled` names the main
 * documents a login was filled into in this tab, and has at least one. Any other document counts
 * unless a fresh navigation or a reload loaded it: Back and Forward refill form fields, whatever
 * address the page shows by then, and a reload refills none.
 */
export const mayShowFill = async (send: SendCommand, filled: ReadonlySet<string>) => {
  const { frameTree } = (await send("Page.getFrameTree")) as {
    readonly frameTree: { readonly frame: { readonly id: string; readonly loaderId: string } };
  };
  const { id, loaderId } = frameTree.frame;
  if (filled.has(loaderId)) return true;
  // Read in an isolated world, where the page cannot answer for itself.
  const { executionContextId } = (await send("Page.createIsolatedWorld", {
    frameId: id,
    worldName: "t3-login-exposure",
  })) as { readonly executionContextId: number };
  const { result } = (await send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: NAVIGATION_TYPE,
    returnByValue: true,
  })) as { readonly result: { readonly value?: unknown } };
  return result.value !== "navigate" && result.value !== "reload";
};
