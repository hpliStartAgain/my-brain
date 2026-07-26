export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Note",
        abstract: "Résumé",
        info: "Info",
        todo: "À faire",
        tip: "Conseil",
        success: "Succès",
        question: "Question",
        warning: "Avertissement",
        failure: "Échec",
        danger: "Danger",
        bug: "Bogue",
        example: "Exemple",
        quote: "Citation",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transclusion de ${targetSlug}`,
        linkToOriginal: "Lien vers l'original",
      },
    },
  },
};
