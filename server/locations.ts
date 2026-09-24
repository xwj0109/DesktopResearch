import path from "node:path";
import {fileURLToPath} from "node:url";
export const installationRoot=fileURLToPath(new URL("../",import.meta.url));
export function productLocations(disposableRoot?:string){
  if(disposableRoot&&!path.isAbsolute(disposableRoot))throw new Error("LAB_STORAGE_ROOT must be an explicit absolute product-owned/disposable path");
  const root=disposableRoot??installationRoot;
  return {root,installation:installationRoot,runtime:path.join(root,".runtime"),workspaces:path.join(root,"workspaces"),dist:path.join(installationRoot,"dist")};
}
