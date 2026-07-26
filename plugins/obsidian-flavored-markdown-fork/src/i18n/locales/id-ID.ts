export default {
  pages: {},
  components: {
    ofm: {
      callout: {
        note: "Catatan",
        abstract: "Abstrak",
        info: "Info",
        todo: "Daftar Tugas",
        tip: "Tips",
        success: "Berhasil",
        question: "Pertanyaan",
        warning: "Peringatan",
        failure: "Gagal",
        danger: "Bahaya",
        bug: "Bug",
        example: "Contoh",
        quote: "Kutipan",
      },
      transcludes: {
        transcludeOf: ({ targetSlug }: { targetSlug: string }) => `Transklusi dari ${targetSlug}`,
        linkToOriginal: "Tautan ke asli",
      },
    },
  },
};
