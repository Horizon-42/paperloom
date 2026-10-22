import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  deriveTitle,
  deriveYear,
  isMeaninglessTitle,
  parseAuthorsInput,
  parseMetadataAuthors,
  titleFromFileName,
  yearFromFileName,
  yearFromPdfDate,
} from "@/services/paperService";

describe("title heuristics", () => {
  it.each([
    "",
    "   ",
    "5023796",
    "Microsoft Word - 2014-NASA-TP-218302.docx",
    "Microsoft Word - hstep_3.doc",
    "Microsoft Word - lf99-16319_ATD1_ConOps_Ver5-2",
    "joes_518.tex",
    "jwuk_acs_1176.dvi",
    "9643Flyleaf.cdr",
    "abcd123.PDF",
    "untitled",
    "Untitled-1",
    "PowerPoint Presentation",
    "Paper Title (use style: paper title)",
    "WP-IP Template",
    "REPORT1234567 1..19",
    "ABCD_X123_Rev_4",
    "2211.14730v2",
    "arXiv:2405.04515",
    "无标题",
  ])("treats %j as meaningless", (t) => {
    expect(isMeaninglessTitle(t)).toBe(true);
  });

  it.each([
    "Social LSTM: Human Trajectory Prediction in Crowded Spaces",
    "AC 12-345B",
    "RoFormer",
    "ABC-12-345678, SYSTEM MODERNIZATION REVIEW",
    "面向长文档的检索增强方法",
  ])("keeps %j", (t) => {
    expect(isMeaninglessTitle(t)).toBe(false);
  });

  it("cleans whitespace and doubled titles", () => {
    expect(cleanTitle("  A   B  ")).toBe("A B");
    expect(cleanTitle("Phased Flight PredictionPhased Flight Prediction")).toBe("Phased Flight Prediction");
  });

  it("falls back to the file name", () => {
    expect(titleFromFileName("ABCD_Smith2025_closed-loop_fine-tuning.pdf")).toBe("ABCD Smith2025 closed-loop fine-tuning");
    expect(titleFromFileName("/a/b/my__paper .PDF")).toBe("my paper");
    expect(deriveTitle({ title: "Microsoft Word - x.docx" }, "Real_Title.pdf")).toBe("Real Title");
    expect(deriveTitle({ title: "untitled", xmpTitle: "Good XMP Title" }, "f.pdf")).toBe("Good XMP Title");
    expect(deriveTitle({ title: "Attention Is All You Need" }, "f.pdf")).toBe("Attention Is All You Need");
    expect(deriveTitle({}, "2211.14730v2.pdf")).toBe("2211.14730v2");
  });
});

describe("year heuristics", () => {
  it("reads PDF dates", () => {
    expect(yearFromPdfDate("D:20230512101010+08'00'")).toBe(2023);
    expect(yearFromPdfDate("5/21/2015 10:00")).toBe(2015);
    expect(yearFromPdfDate("Monday")).toBeUndefined();
    expect(yearFromPdfDate(undefined)).toBeUndefined();
    expect(yearFromPdfDate("D:1601...")).toBeUndefined();
  });

  it("reads years from file names", () => {
    expect(yearFromFileName("ABCD_Smith2025_closed-loop.pdf")).toBe(2025);
    expect(yearFromFileName("doc-1234-manual-16ed-2016.pdf")).toBe(2016);
    expect(yearFromFileName("2211.14730v2.pdf")).toBe(2022);
    expect(yearFromFileName("WP12_ABC-DEF.pdf")).toBeUndefined();
    expect(yearFromFileName("id_123456.pdf")).toBeUndefined();
  });

  it("prefers the file name over the creation date", () => {
    expect(deriveYear({ creationDate: "D:2026" }, "Smith2019_x.pdf")).toBe(2019);
    expect(deriveYear({ creationDate: "D:2021" }, "x.pdf")).toBe(2021);
    expect(deriveYear({}, "x.pdf")).toBeUndefined();
  });
});

describe("author parsing", () => {
  it("splits common metadata formats", () => {
    expect(parseMetadataAuthors("Yi Zhang; Yushen Long; Liping Huang")).toEqual(["Yi Zhang", "Yushen Long", "Liping Huang"]);
    expect(parseMetadataAuthors("Xin Ma, Linxin Zheng, Xikang Lu")).toEqual(["Xin Ma", "Linxin Zheng", "Xikang Lu"]);
    expect(parseMetadataAuthors("Dongdong Gui, Meilong Le, and Andrea D'Ariano")).toEqual([
      "Dongdong Gui",
      "Meilong Le",
      "Andrea D'Ariano",
    ]);
    expect(parseMetadataAuthors("B. Guenin & J. Könemann & L. Tunçel")).toEqual(["B. Guenin", "J. Könemann", "L. Tunçel"]);
    expect(parseMetadataAuthors("Haoyuan Zhang and Zhizhao Liu")).toEqual(["Haoyuan Zhang", "Zhizhao Liu"]);
    expect(parseMetadataAuthors("Alligier, Richard and Gianazza, David and Durand, Nicolas")).toEqual([
      "Richard Alligier",
      "David Gianazza",
      "Nicolas Durand",
    ]);
    expect(parseMetadataAuthors("Holleman, E.C.")).toEqual(["E.C. Holleman"]);
    expect(parseMetadataAuthors("Price, Craig")).toEqual(["Craig Price"]);
    expect(parseMetadataAuthors("张三, 李四")).toEqual(["张三", "李四"]);
    expect(parseMetadataAuthors("王五")).toEqual(["王五"]);
    expect(parseMetadataAuthors("Alevizos Bastas; George Vouros; ")).toEqual(["Alevizos Bastas", "George Vouros"]);
  });

  it("drops junk authors", () => {
    expect(parseMetadataAuthors("mwatson")).toEqual([]);
    expect(parseMetadataAuthors("PDF5")).toEqual([]);
    expect(parseMetadataAuthors("herbert.meyer@easa.europa.eu")).toEqual([]);
    expect(parseMetadataAuthors("")).toEqual([]);
    expect(parseMetadataAuthors("Anonymous Submission")).toEqual([]);
    expect(parseMetadataAuthors("ICAO")).toEqual(["ICAO"]);
  });

  it("parses user input separated by commas or semicolons", () => {
    expect(parseAuthorsInput("张三, 李四；王五;  Alan Turing ,")).toEqual(["张三", "李四", "王五", "Alan Turing"]);
    expect(parseAuthorsInput("  ")).toEqual([]);
  });
});
