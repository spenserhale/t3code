/** The main documents of one browser tab that held a filled login, and every address they showed. */
export interface FilledDocuments {
  readonly documents: ReadonlySet<string>;
  readonly urls: ReadonlySet<string>;
}

export const withoutFragment = (url: string) => url.split("#", 1)[0] ?? url;

/** One CDP command, sent through Playwright or Electron. */
type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const NAVIGATION_TYPE = `performance.getEntriesByType("navigation")[0]?.type ?? ""`;

/**
 * Whether a tab's main document may show a filled password or code: it held a fill, or Back or
 * Forward reached an address one showed, where Chromium refills form fields. A reload or a fresh
 * visit refills none, so the page a site serves at its login address after signing in is clear.
 */
export const mayShowFill = async (send: SendCommand, filled: FilledDocuments) => {
  const { frameTree } = (await send("Page.getFrameTree")) as {
    readonly frameTree: {
      readonly frame: { readonly id: string; readonly loaderId: string; readonly url: string };
    };
  };
  const { id, loaderId, url } = frameTree.frame;
  if (filled.documents.has(loaderId)) return true;
  if (!filled.urls.has(withoutFragment(url))) return false;
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
