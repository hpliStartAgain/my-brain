export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Nota",
        abstract: "Abstract",
        info: "Info",
        todo: "Da fare",
        tip: "Consiglio",
        success: "Completato",
        question: "Domanda",
        warning: "Attenzione",
        failure: "Errore",
        danger: "Pericolo",
        bug: "Problema",
        example: "Esempio",
        quote: "Citazione",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Inclusione di ${targetSlug}`,
        linkToOriginal: "Link all'originale",
      },
    },
  },
};
