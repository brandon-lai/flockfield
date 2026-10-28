/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** The pasture Worker, e.g. https://flockfield.<account>.workers.dev. Absent = offline pasture. */
  readonly VITE_PASTURE_URL?: string;
}
