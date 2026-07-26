export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "ملاحظة",
        abstract: "ملخص",
        info: "معلومات",
        todo: "للقيام",
        tip: "نصيحة",
        success: "نجاح",
        question: "سؤال",
        warning: "تحذير",
        failure: "فشل",
        danger: "خطر",
        bug: "خلل",
        example: "مثال",
        quote: "اقتباس",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `مقتبس من ${targetSlug}`,
        linkToOriginal: "وصلة للملاحظة الرئيسة",
      },
    },
  },
};
