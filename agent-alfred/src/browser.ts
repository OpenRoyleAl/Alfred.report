// Browser Run — Quick Actions via the Worker binding.
// Official createBrowserTools() also needs Worker Loader + CodemodeRuntime.
// Quick Actions (markdown/extract/links/scrape) are the scraping path that
// works from any Worker with only the BROWSER binding.

export type BrowserAction = "markdown" | "extract" | "links" | "scrape" | "content";

export interface BrowserBinding {
  quickAction?(action: string, params: Record<string, unknown>): Promise<Response | unknown>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function truncate(value: unknown, maxChars = 50_000): unknown {
  const encoded = JSON.stringify(value);
  if (encoded.length <= maxChars) return value;
  if (typeof value === "string") return value.slice(0, maxChars);
  return { truncated: true, preview: encoded.slice(0, maxChars) };
}

async function unwrap(result: Response | unknown): Promise<unknown> {
  if (result instanceof Response) {
    const text = await result.text();
    if (!result.ok) {
      throw new Error(`Browser Run ${result.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

export async function runBrowserTask(
  browser: BrowserBinding,
  input: { url: string; action: BrowserAction; instructions?: string },
): Promise<unknown> {
  if (!input.url) throw new Error("url is required");
  const action = input.action || "markdown";
  if (typeof browser.quickAction !== "function") {
    throw new Error("BROWSER binding does not expose quickAction()");
  }

  const params: Record<string, unknown> = { url: input.url };
  if (action === "extract" && input.instructions) {
    params.prompt = input.instructions;
  }
  if (action === "scrape" && input.instructions) {
    params.elements = [{ selector: input.instructions }];
  }

  const raw = await browser.quickAction(action, params);
  return truncate(await unwrap(raw));
}

export function createBrowserTools(browser: BrowserBinding) {
  return {
    async browser_markdown(url: string) {
      return runBrowserTask(browser, { url, action: "markdown" });
    },
    async browser_extract(url: string, instructions?: string) {
      return runBrowserTask(browser, { url, action: "extract", instructions });
    },
    async browser_links(url: string) {
      return runBrowserTask(browser, { url, action: "links" });
    },
    async browser_scrape(url: string, selector?: string) {
      return runBrowserTask(browser, { url, action: "scrape", instructions: selector });
    },
  };
}
