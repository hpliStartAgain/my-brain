export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Note",
        abstract: "Abstract",
        info: "Info",
        todo: "Todo",
        tip: "Tip",
        success: "Success",
        question: "Question",
        warning: "Warning",
        failure: "Failure",
        danger: "Danger",
        bug: "Bug",
        example: "Example",
        quote: "Quote",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transclude of ${targetSlug}`,
        linkToOriginal: "Link to original",
      },
    },
  },
};
