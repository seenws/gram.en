// esbuild imports *.gram as text; this lets the type-checker accept that import
declare module "*.gram" {
    const content: string;
    export default content;
}
