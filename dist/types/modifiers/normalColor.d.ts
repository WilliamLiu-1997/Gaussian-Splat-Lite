import { SplatTransformer } from '../SplatGenerator';
import { SplatMesh } from '../SplatMesh';
export declare function makeNormalColorModifier(splatToView: SplatTransformer): import('../dyno').DynoBlock<{
    gsplat: {
        type: "Gsplat";
    };
}, {
    gsplat: {
        type: "Gsplat";
    };
}>;
export declare function setWorldNormalColor(splats: SplatMesh): void;
