export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Poznámka",
        abstract: "Abstract",
        info: "Info",
        todo: "Todo",
        tip: "Tip",
        success: "Úspěch",
        question: "Otázka",
        warning: "Upozornění",
        failure: "Chyba",
        danger: "Nebezpečí",
        bug: "Bug",
        example: "Příklad",
        quote: "Citace",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Zobrazení ${targetSlug}`,
        linkToOriginal: "Odkaz na původní dokument",
      },
    },
  },
};
