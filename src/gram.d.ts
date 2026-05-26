// esbuild imports *.gram as text (see the build script); this declaration keeps
// the editor's type-checker happy about that import.
declare module "*.gram" {
    const content: string;
    export default content;
}
