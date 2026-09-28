// Product identity extension point (T-A1, INV-1): the binary name the product
// ships under. brand.yaml `binary_name` is the source of record; brand-lint
// enforces that this constant mirrors it, so upstream syncs that touch this
// file fail lint instead of silently drifting from the manifest.
export const CLI_COMMAND_NAME = "latch";
export const CLI_PROCESS_NAME = "latch-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
