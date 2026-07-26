export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Pastaba",
        abstract: "Santrauka",
        info: "Informacija",
        todo: "Darbų sąrašas",
        tip: "Patarimas",
        success: "Sėkmingas",
        question: "Klausimas",
        warning: "Įspėjimas",
        failure: "Nesėkmingas",
        danger: "Pavojus",
        bug: "Klaida",
        example: "Pavyzdys",
        quote: "Citata",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Įterpimas iš ${targetSlug}`,
        linkToOriginal: "Nuoroda į originalą",
      },
    },
  },
};
