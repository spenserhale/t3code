import { PreviewCaptureFailure, type PreviewCaptureFailureEncoded } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCaptureFailure = Schema.decodeUnknownOption(PreviewCaptureFailure);

// Decode here because contextBridge strips custom properties from rejected Errors.
function unwrapPreviewCaptureResult<A>(result: A | PreviewCaptureFailureEncoded): A {
  const failure = decodeCaptureFailure(result);
  if (Option.isSome(failure)) throw failure.value;
  return result as A;
}

const nativePreviewBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);

export const previewBridge = nativePreviewBridge
  ? {
      ...nativePreviewBridge,
      captureScreenshot: async (tabId: string) =>
        unwrapPreviewCaptureResult(await nativePreviewBridge.captureScreenshot(tabId)),
      recording: {
        ...nativePreviewBridge.recording,
        startScreencast: async (tabId: string) =>
          unwrapPreviewCaptureResult(await nativePreviewBridge.recording.startScreencast(tabId)),
        save: async (tabId: string, mimeType: string, data: Uint8Array) =>
          unwrapPreviewCaptureResult(
            await nativePreviewBridge.recording.save(tabId, mimeType, data),
          ),
      },
    }
  : null;
