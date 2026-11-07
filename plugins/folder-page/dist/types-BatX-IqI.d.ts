import { QuartzPageTypePlugin, SortFn } from '@quartz-community/types';

interface FolderPageOptions {
    showFolderCount?: boolean;
    showSubfolders?: boolean;
    sort?: SortFn;
    /** Show "Folder: " prefix before folder name in generated titles. Default: false */
    prefixFolders?: boolean;
}
declare const FolderPage: QuartzPageTypePlugin<FolderPageOptions>;

export { FolderPage as F, type FolderPageOptions as a };
