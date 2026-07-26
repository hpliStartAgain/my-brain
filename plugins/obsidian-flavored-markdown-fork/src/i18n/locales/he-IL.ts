export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "הערה",
        abstract: "תקציר",
        info: "מידע",
        todo: "לעשות",
        tip: "טיפ",
        success: "הצלחה",
        question: "שאלה",
        warning: "אזהרה",
        failure: "כשלון",
        danger: "סכנה",
        bug: "באג",
        example: "דוגמה",
        quote: "ציטוט",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `מצוטט מ ${targetSlug}`,
        linkToOriginal: "קישור למקורי",
      },
    },
  },
};
