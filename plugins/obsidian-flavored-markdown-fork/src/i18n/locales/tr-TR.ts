export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Not",
        abstract: "Özet",
        info: "Bilgi",
        todo: "Yapılacaklar",
        tip: "İpucu",
        success: "Başarılı",
        question: "Soru",
        warning: "Uyarı",
        failure: "Başarısız",
        danger: "Tehlike",
        bug: "Hata",
        example: "Örnek",
        quote: "Alıntı",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) =>
          `${targetSlug} sayfasından alıntı`,
        linkToOriginal: "Orijinal bağlantı",
      },
    },
  },
};
