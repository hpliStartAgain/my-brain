export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Hinweis",
        abstract: "Zusammenfassung",
        info: "Info",
        todo: "Zu erledigen",
        tip: "Tipp",
        success: "Erfolg",
        question: "Frage",
        warning: "Warnung",
        failure: "Fehlgeschlagen",
        danger: "Gefahr",
        bug: "Fehler",
        example: "Beispiel",
        quote: "Zitat",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transklusion von ${targetSlug}`,
        linkToOriginal: "Link zum Original",
      },
    },
  },
};
