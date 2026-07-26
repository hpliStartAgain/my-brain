export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Nota",
        abstract: "Resum",
        info: "Informació",
        todo: "Per fer",
        tip: "Consell",
        success: "Èxit",
        question: "Pregunta",
        warning: "Advertència",
        failure: "Fall",
        danger: "Perill",
        bug: "Error",
        example: "Exemple",
        quote: "Cita",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transcluit de ${targetSlug}`,
        linkToOriginal: "Enllaç a l'original",
      },
    },
  },
};
