export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "یادداشت",
        abstract: "چکیده",
        info: "اطلاعات",
        todo: "اقدام",
        tip: "نکته",
        success: "تیک",
        question: "سؤال",
        warning: "هشدار",
        failure: "شکست",
        danger: "خطر",
        bug: "باگ",
        example: "مثال",
        quote: "نقل قول",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `از ${targetSlug}`,
        linkToOriginal: "پیوند به اصلی",
      },
    },
  },
};
