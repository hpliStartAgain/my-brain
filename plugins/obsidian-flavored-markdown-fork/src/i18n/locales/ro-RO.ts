export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Notă",
        abstract: "Rezumat",
        info: "Informație",
        todo: "De făcut",
        tip: "Sfat",
        success: "Succes",
        question: "Întrebare",
        warning: "Avertisment",
        failure: "Eșec",
        danger: "Pericol",
        bug: "Bug",
        example: "Exemplu",
        quote: "Citat",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Extras din ${targetSlug}`,
        linkToOriginal: "Legătură către original",
      },
    },
  },
};
