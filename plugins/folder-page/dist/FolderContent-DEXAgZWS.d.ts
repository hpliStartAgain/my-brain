import { SortFn, QuartzComponent } from '@quartz-community/types';

interface FolderContentOptions {
    showFolderCount: boolean;
    showSubfolders: boolean;
    sort?: SortFn;
}
declare const _default: (opts?: Partial<FolderContentOptions>) => QuartzComponent;

export { _default as _ };
