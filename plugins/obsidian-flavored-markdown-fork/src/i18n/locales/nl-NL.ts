export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Notitie",
        abstract: "Samenvatting",
        info: "Info",
        todo: "Te doen",
        tip: "Tip",
        success: "Succes",
        question: "Vraag",
        warning: "Waarschuwing",
        failure: "Mislukking",
        danger: "Gevaar",
        bug: "Bug",
        example: "Voorbeeld",
        quote: "Citaat",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Invoeging van ${targetSlug}`,
        linkToOriginal: "Link naar origineel",
      },
    },
  },
};
