export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Notatka",
        abstract: "Streszczenie",
        info: "informacja",
        todo: "Do zrobienia",
        tip: "Wskazówka",
        success: "Zrobione",
        question: "Pytanie",
        warning: "Ostrzeżenie",
        failure: "Usterka",
        danger: "Niebiezpieczeństwo",
        bug: "Błąd w kodzie",
        example: "Przykład",
        quote: "Cytat",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Osadzone ${targetSlug}`,
        linkToOriginal: "Łącze do oryginału",
      },
    },
  },
};
