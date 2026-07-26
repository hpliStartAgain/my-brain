export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Notis",
        abstract: "Abstrakt",
        info: "Info",
        todo: "Husk på",
        tip: "Tips",
        success: "Suksess",
        question: "Spørsmål",
        warning: "Advarsel",
        failure: "Feil",
        danger: "Farlig",
        bug: "Bug",
        example: "Eksempel",
        quote: "Sitat",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transkludering of ${targetSlug}`,
        linkToOriginal: "Lenke til original",
      },
    },
  },
};
