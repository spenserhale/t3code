import type { PreviewAnnotationPayload } from "@t3tools/contracts";

/**
 * An annotation of a page that may show a filled login, cut down to what the person made: the
 * comment, the marks and where they are, and the style values they chose. A page can copy a
 * login into anything it supplies, so its title, address, element text and styles all go.
 * `origin` is the site as the browser knows it, not as the page reports it.
 */
export const withoutPageContent = (
  annotation: PreviewAnnotationPayload,
  origin: string,
): PreviewAnnotationPayload => ({
  id: annotation.id,
  pageUrl: origin,
  pageTitle: null,
  comment: annotation.comment,
  elements: annotation.elements.map(({ id, rect, element }) => ({
    id,
    rect,
    element: {
      pageUrl: origin,
      pageTitle: null,
      tagName: "",
      selector: null,
      htmlPreview: "",
      componentName: null,
      source: null,
      stack: [],
      styles: "",
      pickedAt: element.pickedAt,
    },
  })),
  regions: annotation.regions,
  strokes: annotation.strokes,
  styleChanges: annotation.styleChanges.map(({ targetId, property, value }) => ({
    targetId,
    selector: null,
    property,
    previousValue: "",
    value,
  })),
  screenshot: null,
  createdAt: annotation.createdAt,
});
