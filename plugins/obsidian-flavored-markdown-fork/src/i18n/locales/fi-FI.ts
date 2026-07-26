export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Merkintä",
        abstract: "Tiivistelmä",
        info: "Info",
        todo: "Tehtävälista",
        tip: "Vinkki",
        success: "Onnistuminen",
        question: "Kysymys",
        warning: "Varoitus",
        failure: "Epäonnistuminen",
        danger: "Vaara",
        bug: "Virhe",
        example: "Esimerkki",
        quote: "Lainaus",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Upote kohteesta ${targetSlug}`,
        linkToOriginal: "Linkki alkuperäiseen",
      },
    },
  },
};
