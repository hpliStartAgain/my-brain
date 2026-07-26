export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Jegyzet",
        abstract: "Abstract",
        info: "Információ",
        todo: "Tennivaló",
        tip: "Tipp",
        success: "Siker",
        question: "Kérdés",
        warning: "Figyelmeztetés",
        failure: "Hiba",
        danger: "Veszély",
        bug: "Bug",
        example: "Példa",
        quote: "Idézet",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `${targetSlug} áthivatkozása`,
        linkToOriginal: "Hivatkozás az eredetire",
      },
    },
  },
};
