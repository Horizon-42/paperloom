/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 用户没有选择过时的界面语言（zh / en），缺省英文；见 src/i18n/index.ts */
  readonly VITE_PAPERLENS_DEFAULT_LOCALE?: string;
}
