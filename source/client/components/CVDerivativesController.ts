
import CObject3D, { Node, types } from "@ff/scene/components/CObject3D";
import CScene from "@ff/scene/components/CScene";
import CVModel2 from "./CVModel2";
import CPulse, { IPulseContext, IPulseEvent } from "@ff/graph/components/CPulse";
import Component from "@ff/graph/Component";
import { EAssetType, EDerivativeQuality, EDerivativeUsage } from "client/schema/model";
import CRenderer from "@ff/scene/components/CRenderer";
import { Vector2, Vector3, Box3, Matrix4, Object3D, Quaternion, Spherical, Plane, Camera, Box2, Euler } from "three";
import CTransform from "@ff/scene/components/CTransform";
import CVNode from "./CVNode";
import * as helpers from "@ff/three/helpers";

interface ILOD{
  enabled?:boolean;
}

/**
 * Expected map sizes in pixels
 * The number given is number of pixels for a square map of the expected quality
 */
const sizes = {
  [EDerivativeQuality.High]: 4096*4096,
  [EDerivativeQuality.Medium]: 2048*2048,
  [EDerivativeQuality.Low]: 1024*1024,
  [EDerivativeQuality.Thumb]: 512*512,
} as const

/**Absolute minimum value under which we do not expect to be able to function properly */
const MIN_BUDGET = sizes[EDerivativeQuality.High]*2;

interface ModelDisplayState{
  model :CVModel2;
  qualityRequest :EDerivativeQuality;
  clipped :boolean;
  weight: number;
}

function getSize(model :CVModel2, quality :EDerivativeQuality) :number{
  const bestMatchDerivative = model.derivatives.select(EDerivativeUsage.Web3D, quality);
  const asset = bestMatchDerivative.findAsset(EAssetType.Model);
  return ((asset?.data?.imageSize )? Math.pow(asset.data.imageSize, 2): sizes[bestMatchDerivative.data.quality]);
}

/**
 * How far from center is the centermost part of the object?
 * dxy = 0: Object crosses the image's center
 * dxy = 1 object's nearest point would be just outside screen space if located on the X or Y axis
 * dxy = 2: Object's nearest border is just beyond the screen's diagonal edge
 * We add X offset and Y offset because we kind of _want_ diagonals to be a little underweighted
 * 
 */
export function maxCenterWeight(b :Box3){
    let dxy = Math.max(-b.max.x, b.min.x, 0) + Math.max(-b.max.y, b.min.y, 0);
    return 1 / (Math.pow(1+dxy,4));
}


const hyst = 0.02; //In absolute % of screen area unit
const steps = [
    [0.04, EDerivativeQuality.Thumb],
    [0.1, EDerivativeQuality.Low],
    [0.4, EDerivativeQuality.Medium],
];
/**
 * Calculate desired quality setting
 * 
 * An hysteresis is necessary to prevent flickering, 
 * but it would be interesting to configure if we upgrade-first or downgrade-first
 * depending on resources contention 
 * 
 * @fixme here we should take into account the renderer's resolution:
 * we probably don't need a 4k texture when rendering an object over 40% of a 800px viewport
 */
export function getQuality(current :EDerivativeQuality, relSize:number):EDerivativeQuality{
  return steps.find(([size, q])=>{
      if (current <= q) size += hyst;
      return relSize < size;
  })?.[1] ?? EDerivativeQuality.High;
}

const _ndcBox = new Box3();
const _localBox = new Box3(); // i world coordi
const _cameraXAxis = new Vector3();
const _cameraYAxis = new Vector3();
const _vec3a = new Vector3();
const _vecSphericala = new Spherical();
const _vec3b = new Vector3();
const _vecSphericalb = new Spherical();
const _quat = new Quaternion();
const _mat4 = new Matrix4();
const _cam_fwd = new Vector3(0, 0, 1);
const _ndc_fwd = new Vector3(0, 0, 1);

/**
 * Simple moving average basic implementation
 */
class PerfCounter{
  private _prev : number = 0;
  private _buf :number[];
  private _cursor = 0;
  /**
   * 
   * @param length Moving average length
   * @param initial initial value to prefill the array with, defaults to 0
   */
  constructor(length:number, initial ?:number){
    this._buf = new Array(length);
    if(typeof initial === "number") this.reset(initial);
  }

  /**
   * Add a timestamp
   * @param {number} t Timestamp
   * @param {number} mult Multiplier (how many frames elapsed)
   */
  push(t :number, mult:number) :number{
    this._buf[this._cursor] = mult/(t - this._prev);
    this._prev = t;
    this._cursor = (this._cursor + 1) % this._buf.length;
    return this.get();
  }

  get() :number{
    return this._buf.reduce((sum, value)=>sum + value, 0) / this._buf.length;
  }

  reset(n :number){
    for(let i = 0; i< this._buf.length; i++){
      this._buf[i] = n;
    }
  }
}

/**
 * Dynamic LOD handling. * 
 */
export default class CVDerivativesController extends Component{

  static readonly typeName: string = "CVDerivativesController";
  static readonly isSystemSingleton: boolean = true;

  static readonly text: string = "Derivatives selection";
  static readonly icon: string = "";

  private _fps = new PerfCounter(10, 60);

  private _budget = sizes[EDerivativeQuality.High]*2;
  spherical: boolean= false;

  threshold(q :EDerivativeQuality){
    return this._budget - sizes[q]*2;
  }

  protected static readonly ins = {
    enabled: types.Boolean("Settings.Enabled", true),
  }


  ins = this.addInputs<CObject3D, typeof CVDerivativesController.ins>(CVDerivativesController.ins);


  get settingProperties() {
    return [
        this.ins.enabled,
    ];
  }
  private _scene :CScene;
  protected get renderer() {
    return this.getMainComponent(CRenderer);
  }

  get activeScene(){
    return this.renderer?.activeSceneComponent;
  }

  constructor(node: Node, id: string)
  {
      super(node, id);
      this._scene = this.activeScene;
      this.renderer.outs.maxTextureSize.on("value", this.setTextureBudget);
  }


  setTextureBudget = ()=> {
    // We expect scene performance to always be texture-limited.
    // For example a hundred untextured objects with 25k vertices each would pose absolutely no problem even to a low end mobile device. 
    // However a few 4k maps are enough to overload such a device's GPU and internet connection.
    // First, evaluate raw maximum texture space as an upper bound. This is halved because:
    //  1. we don't particularly want to max-out. This is not a "reasonable", but a "system max supported" value. 
    //  2. This is total available space and any object can have any number of textures (we'd be able to refine this exact number if we wanted)
    //      to which we need to add lightmaps, environment, etc. We just simplify to 1/4 the texture space
    let budget = Math.pow(this.renderer.outs.maxTextureSize.value/2, 2);
    if(typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency < 4){
      console.debug("Reduce budget because of low CPU count");
      budget = budget/2;
    }
    if((navigator as any).userAgentData?.mobile){
      console.debug("Reduce budget because of mobile device");
      budget = budget/1.5; //
    }
    if(typeof (navigator as any).deviceMemory === "number" && (navigator as any).deviceMemory < 8){
      console.debug("Reduce budget because of low RAM");
      budget = Math.min(budget, sizes[EDerivativeQuality.High]*4);
    }
    this._budget = Math.max(MIN_BUDGET, budget);
    console.debug("Performance budget: ", Math.sqrt(this._budget));
  }

  tock(context :IPulseContext) :boolean{
    const cameraComponent = this._scene?.activeCameraComponent;
    if (!this.ins.enabled.value || !cameraComponent) {
        return false;
    }
    //We only recompute LOD every 20 frames
    if((context.frameNumber % 20) != 0){
      return false;
    }

    if((context.frameNumber % 120) == 0){
      if(this._fps.push(context.secondsElapsed, 120) < 40 && MIN_BUDGET < this._budget){
        this._budget = Math.max(MIN_BUDGET, this._budget - sizes[EDerivativeQuality.Low]);
        console.debug("Reducing performance budget to %d (%d average fps)", Math.sqrt(this._budget), this._fps.get());
        //Prevent this from triggering too much : artificially reset our fps average to 60
        this._fps.reset(60);
      }
    }

    cameraComponent.camera.getWorldDirection(_cam_fwd);

    let currently_loading = 0;
    const weights :Array<[string, any]>= [];
    const sphericalWeights :Array<[string, any]>= [];
    let bloup = 0;
//    let faceDebug = (x) => (x== 12 || x==9) ;
    let faceDebug = (x) => (false) ;
 //   console.log("La face observée est :", faceDebug);
    let worldQuaternion = new Quaternion;
    cameraComponent.camera.getWorldQuaternion(worldQuaternion)
    _cameraXAxis.set(1,0,0);
    _cameraXAxis.applyQuaternion(worldQuaternion);
 //  console.log ("Camera x Axis : ", _cameraXAxis);
    _cameraYAxis.set(0,1,0);
    _cameraYAxis.applyQuaternion(worldQuaternion);
    console.log ("Camera y Axis : ", _cameraYAxis);
    const quaternion90AroundZ = new Quaternion;
    quaternion90AroundZ.setFromEuler(new Euler(0,0,Math.PI/2));
//    console.log ("Y Axis + z rotation: ", _cameraYAxis.clone().set(0,1,0).applyQuaternion(quaternion90AroundZ));


//    let box = new Box3 (new Vector3 (0, 0, 0), new Vector3 (0, 1, 1));
//    let box2 = new Box3 (new Vector3 (0, 0, -2), new Vector3 (1, 0, -1));

//    let flatBox = new Box3 (new Vector3 (-1, 0, 0), new Vector3 (1, 0, 1));
//    let plane = new Plane (new Vector3(0,1,0),0);
//   let plane2 = new Plane (new Vector3(1,0,0),0.5);
//    console.log("box/plane intersect : ", box.intersectsPlane(plane), plane.intersectsBox(box));
//   console.log("box/plane intersect2 : ", box2.intersectsPlane(plane2));
//    console.log("flatBox/plane intersect : ", flatBox.intersectsPlane(plane), plane.intersectsBox(flatBox));


    let collection :Array<ModelDisplayState> = this.getGraphComponents(CVModel2).map(model=>{
      bloup = bloup + 1;
      _ndcBox.makeEmpty();
      let sphericalCoordinates: Array<Spherical>= [];
      let rotatedSphericalCoordinates: Array<Spherical>= [];
      let facingSphericalCoordinates: Array<Spherical>= [];
      let facingrotatedSphericalCoordinates: Array<Spherical>= [];
      const faceBoxQuaternion = new Quaternion;
      //We can't just use the model's matrixWorld here because it might not have loaded yet.
      //In this case the bounding box is whatever's defined in the scene file.
      const scale = model.outs.unitScale.value;
      let t :CTransform|CVNode = model.transform;
      _localBox.copy(model.localBoundingBox);
      //_localBox.min.multiplyScalar(scale);
      //_localBox.max.multiplyScalar(scale);
      const boxCenterInCamera = new Vector3; 
 
      _vec3a.fromArray(model.ins.position.value).multiplyScalar(scale);
      helpers.degreesToQuaternion(model.ins.rotation.value, CVModel2.rotationOrder, _quat);
      _vec3b.setScalar(scale);
      _mat4.compose(_vec3a, _quat, _vec3b);
      _localBox.applyMatrix4(_mat4);

      while(t){
        _mat4.fromArray(t.outs.matrix.value);
        _localBox.applyMatrix4(_mat4);
        t = t.parent as CTransform|CVNode;
      }
      let clipped = true;
      //Ideally we use NDC (Normalized Display Coordinates) to compute the perceived size of an object on-screen
      //The thing with NDC is they are crap at representing objects that are on the side of the camera
      //They tends to have infinite (X,Y) sizes that don't make any sense
      //Additionally it's hard to make sense of objects that crosses the camera's cross plane.
      [
        [_localBox.min.x, _localBox.min.y, _localBox.min.z],
        [_localBox.max.x, _localBox.min.y, _localBox.min.z],
        [_localBox.max.x, _localBox.max.y, _localBox.min.z],
        [_localBox.max.x, _localBox.max.y, _localBox.max.z],
        [_localBox.min.x, _localBox.max.y, _localBox.max.z],
        [_localBox.min.x, _localBox.min.y, _localBox.max.z],
        [_localBox.max.x, _localBox.min.y, _localBox.max.z],
        [_localBox.min.x, _localBox.max.y, _localBox.min.z],
      ].forEach((coords:[number, number, number], index)=>{
          _vec3a.set(...coords).project(cameraComponent.camera);
          if(/*cameraComponent.camera.near < _vec3a.z &&*/ _vec3a.z < 1){
            if(Math.abs(_vec3a.x) < 1 && Math.abs(_vec3a.y) < 1){
              clipped = false;
            }
            _ndcBox.expandByPoint(_vec3a);
          }
      });

      ///// ============GETTING SPHERICAL COORDINATES OF THE BOX ============


      let cameraPosition = new Vector3;
      cameraComponent.camera.getWorldPosition(cameraPosition);
      [
        [_localBox.min.x, _localBox.min.y, _localBox.min.z],
        [_localBox.max.x, _localBox.min.y, _localBox.min.z],
        [_localBox.max.x, _localBox.max.y, _localBox.min.z],
        [_localBox.max.x, _localBox.max.y, _localBox.max.z],
        [_localBox.min.x, _localBox.max.y, _localBox.max.z],
        [_localBox.min.x, _localBox.min.y, _localBox.max.z],
        [_localBox.max.x, _localBox.min.y, _localBox.max.z],
        [_localBox.min.x, _localBox.max.y, _localBox.min.z],
      ].map((coords:[x: number,y:  number,z: number], index)=>{

          _vec3a.set(...coords).sub(cameraPosition);
          cameraComponent.camera.getWorldQuaternion(worldQuaternion);
          _vec3a.applyQuaternion(worldQuaternion.clone().conjugate()); 

          _vecSphericala.setFromVector3(_vec3a);
          sphericalCoordinates.push(_vecSphericala.clone())


          const _vecRotatedAroundZ = _vec3a.clone().applyQuaternion(quaternion90AroundZ.conjugate()); 
          _vecSphericalb.setFromVector3(_vecRotatedAroundZ);
          rotatedSphericalCoordinates.push(_vecSphericalb.clone());


        //=================  Theta 3 and 4,  facing the box ================
        _localBox.getCenter(_vec3b);
        if (faceDebug (bloup) ){
//                   console.log(" local box ",bloup.toString()," : ",_localBox.clone());
//                   console.log(" coordonnées world centre boite:",  _vec3b.clone());
        }
        _vec3b.sub(cameraPosition);
        _vec3b.applyQuaternion(worldQuaternion.clone().conjugate()); 
        boxCenterInCamera.copy(_vec3b);

 
        faceBoxQuaternion.setFromUnitVectors(boxCenterInCamera.clone().normalize(), new Vector3(0,0,-1));
        const boxFacingCoordinates = _vec3a.clone().applyQuaternion(faceBoxQuaternion);
        _vecSphericalb.setFromVector3(boxFacingCoordinates);
        facingSphericalCoordinates.push(_vecSphericalb.clone());

        const boxFacingSphericalCoordinatesRotated = boxFacingCoordinates.clone().applyQuaternion(quaternion90AroundZ.conjugate()); 
        _vecSphericalb.setFromVector3(boxFacingSphericalCoordinatesRotated);
        facingrotatedSphericalCoordinates.push(_vecSphericalb.clone());

        // ===============  ^^^ theta 3 and 4 ^^^ ============


        if (faceDebug (bloup) ){
          //         console.log ("=========================================================");
//                   console.log("cartesian rotated coordinates with camera quaternion conjugate :", _vec3a.clone());
         /*          console.log(" coordonnées sphériques :",  _vecSphericala.clone());
       //            console.log("cartesian rotated coordinates with camera quaternion conjugate + z rotation:", _vecRotatedAroundZ.clone());
                   console.log(" coordonnées sphériques tournées:",  _vecSphericalb.clone());*/
//                   console.log(" coordonnées face à la boite", bloup.toString() ," :",  boxFacingCoordinates.clone());
                }
        });

      if (faceDebug (bloup)){
//        console.log("Center of the box ",bloup.toString(), " : ", boxCenterInCamera, boxCenterInCamera.clone().applyQuaternion(faceBoxQuaternion));
        console.log("coordonnées camera : ", cameraPosition);
      }
      /// ==========================^^^^^^^^^^===================================

      cameraComponent.camera.getWorldPosition(_vec3a);
      //Best-case distance
      let distance =  _localBox.distanceToPoint(_vec3a)/cameraComponent.camera.far;
      let angle = 0;
      if(distance != 0){
        _vec3a.set(
          (_ndcBox.min.x < 0 && 0 < _ndcBox.max.x)? 0: Math.min(Math.abs(_ndcBox.max.x), Math.abs(_ndcBox.min.x)),
          (_ndcBox.min.y < 0 && 0 < _ndcBox.max.y)?0: Math.min(Math.abs(_ndcBox.max.y), Math.abs(_ndcBox.min.y)),
          _ndcBox.max.z,
        );
        angle = _vec3a.angleTo(_ndc_fwd); // angle minimal par rapport à la boite
      }
      ////====================== box camera distance  =============================
      const cameraMatrix = Camera
     // let cameraPosition = new Vector3
      //cameraComponent.camera.getWorldPosition(cameraPosition)
      let boxCameraDistance = distance;
      let sphericalDistanceWeight = 1;
      let sphericalAngularArea = 1;
      let sphericalAngularDistance = Infinity;
      if (boxCameraDistance > 0){
        if (faceDebug (bloup) ){
//         console.log("localBox", {x_max: _localBox.max.x, y_max: _localBox.max.y, z_max: _localBox.max.z}, {x_min: _localBox.min.x, y_min: _localBox.min.y, z_min: _localBox.min.z});
//          console.log("fwd camera", _cam_fwd);
//          console.log("Camera position",{x:cameraPosition.x, y:cameraPosition.y, z:cameraPosition.z} );
//         console.log("Spherical coordinates theta", sphericalCoordinates[0].theta, sphericalCoordinates[1].theta,sphericalCoordinates[2].theta, sphericalCoordinates[3].theta)
 }
        //// =================== Calculate angle differences ========================
        // The box does NOT include the camera 
        // To measure how the object circular arcs are distant from the center of the camera. 

        // =============== Theta angle ===============================
        // pb when object below or above camera -> pi
        // used now only for distance 
        let maxTheta = Math.max(...sphericalCoordinates.map((point: Spherical)=> point.theta));
        let minTheta = Math.min(...sphericalCoordinates.map((point: Spherical)=> point.theta));
  //      let thetaAngle = maxTheta - minTheta;
        //let thetaDistance = new Box2(new Vector2(maxTheta, 1), new Vector2(minTheta, -1)).distanceToPoint(new Vector2(Math.PI,0)); // Did not find an interval implementation in threeJS
        let thetaDistance = Math.PI - Math.max(Math.abs(maxTheta), Math.abs(minTheta));

        
        // check if the box is across the half plane where changes sign and z < 0 (ie seen by the camera)
        // local box is in world coordinates
        const boxMinInCameraCoordinates = new Vector3(_localBox.min.x,_localBox.min.y, _localBox.min.z);
        boxMinInCameraCoordinates.sub(cameraPosition).applyQuaternion(worldQuaternion.clone().conjugate());
        const isBoxAcrossThetaHalfPlane: boolean = _localBox.intersectsPlane(new Plane(_cameraXAxis,-_cameraXAxis.dot(cameraPosition))) && (boxMinInCameraCoordinates.z < 0);
    //   if (faceDebug(bloup)){
       /*   console.log("local box ", bloup.toString(), " : ", {min_x: _localBox.min.x, min_y: _localBox.min.y, min_z:_localBox.min.z, max_x: _localBox.max.x, max_y: _localBox.max.y, max_z: _localBox.max.z});
          console.log("boxMinInCameraCoordinates i camera coor: ", boxMinInCameraCoordinates.clone());
          console.log("isBoxAcrossThetaHalfPlane: ", isBoxAcrossThetaHalfPlane);
//          console.log(_localBox.min.clone().applyQuaternion(worldQuaternion.conjugate()).z );
     //     console.log("box : ", {min_x: _localBox.min.x, min_y: _localBox.min.y, min_z:_localBox.min.z, max_x: _localBox.max.x, max_y: _localBox.max.y, max_z: _localBox.max.z});
          let cameraThetaPlane = new Plane(_cameraXAxis,-_cameraXAxis.dot(cameraPosition));
          console.log("Plane : x :", cameraThetaPlane.normal.x, cameraThetaPlane.normal.y, cameraThetaPlane.normal.z, "constante : ", cameraThetaPlane.constant);
          console.log("Camera position :", cameraPosition.x, cameraPosition.y, cameraPosition.z);
//          console.log(_localBox.intersectsPlane(cameraThetaPlane));
//          console.log(_localBox.min.dot(cameraThetaPlane.normal), _localBox.max.dot(cameraThetaPlane.normal));*/
   //     }
        if (isBoxAcrossThetaHalfPlane){ 
     /*   let maxThetaNeg = Math.max(...sphericalCoordinates.filter((point: Spherical)=> point.theta<0).map((point: Spherical)=> point.theta));
          let minThetaPos = Math.min(...sphericalCoordinates.filter((point: Spherical)=> point.theta>0).map((point: Spherical)=> point.theta));  
          thetaAngle = 2*Math.PI - minThetaPos + maxThetaNeg;*/ 
          thetaDistance = 0;
//          if (faceDebug(bloup)){//
//              console.log("maxThetaNeg :", maxThetaNeg, " - minThetaPos : ", minThetaPos, " - thetaAngle : ", thetaAngle);
//               console.log("box ", bloup.toString()," across half plane, thetaAngle :", thetaAngle);
//          }
        };
/*        if (faceDebug(bloup)){
          console.log("maxTheta :", maxTheta, " - minTheta : ", minTheta, " - thetaAngle : ", thetaAngle, "acrossTheta: ", isBoxAcrossThetaHalfPlane);
        }*/
/*
        // ========== Theta angle 2 ============
        // rotated 90° z --- pb when object below or above camera -> pi
        // used only for distance */
        let maxTheta2 = Math.max(...rotatedSphericalCoordinates.map((point: Spherical)=> point.theta));
        let minTheta2 = Math.min(...rotatedSphericalCoordinates.map((point: Spherical)=> point.theta));
        //let thetaAngle2 = maxTheta2 - minTheta2;
        let thetaDistance2 = Math.PI - Math.max(Math.abs(maxTheta2), Math.abs(minTheta2));

        const isBoxAcrossTheta2HalfPlane: boolean = _localBox.intersectsPlane(new Plane(_cameraYAxis,-_cameraYAxis.dot(cameraPosition))) && (boxMinInCameraCoordinates.z < 0);
        if (isBoxAcrossTheta2HalfPlane){ 
          //let maxTheta2Neg = Math.max(...rotatedSphericalCoordinates.filter((point: Spherical)=> point.theta<0).map((point: Spherical)=> point.theta));
          //let minTheta2Pos = Math.min(...rotatedSphericalCoordinates.filter((point: Spherical)=> point.theta>0).map((point: Spherical)=> point.theta));  
          //thetaAngle2 = 2*Math.PI - minTheta2Pos + maxTheta2Neg; 
          thetaDistance2 = 0;
        };
/*
        if (faceDebug(bloup)){
          console.log("maxTheta2 :", maxTheta2, " - minTheta2 : ", minTheta2, " - thetaAngle2 : ", thetaAngle2, "acrossTheta2: ", isBoxAcrossTheta2HalfPlane );
        }
  */      
/*
        //  ============ Phi angle =============
        // issues due to phi rotating+ poles
        let phiAngle = 0;
        let phiDistance = Math.PI/2; 

        // check if the y axis goes trough the box
        /*
        let zCameraAxis = new Vector3(0,0,1);
        zCameraAxis.applyQuaternion(worldQuaternion.conjugate());
        const yAxisThroughTheBox: boolean = _localBox.intersectsPlane(new Plane(_cameraXAxis, -_cameraXAxis.dot(cameraPosition))) && _localBox.intersectsPlane(new Plane(zCameraAxis,-zCameraAxis.dot(cameraPosition))); // Maybe rewrite with Ray?
        if (yAxisThroughTheBox){ // if it goes through the box (we know the camera is NOT IN the box)
          if (sphericalCoordinates[0].phi < Math.PI/2){ // Case where the box is above
            if(faceDebug(bloup)) {
                console.log("Is above");
            }
            let maxPhi1 = Math.max(...sphericalCoordinates.filter((point:Spherical)=> point.theta>0).map((point: Spherical)=> point.phi)); 
            let maxPhi2 = Math.max(...sphericalCoordinates.filter((point:Spherical)=> point.theta<0).map((point: Spherical)=> point.phi));
            phiAngle = maxPhi1 + maxPhi2
            phiDistance = new Box2(new Vector2(maxPhi1, 0), new Vector2(maxPhi2, 0)).distanceToPoint(new Vector2(Math.PI/2,0)); // Did not find an interval implementation in threeJS
          } else { // Case where the box is below
            if(faceDebug(bloup)) {
              console.log("Is below");
          }
            let minPhi1 = Math.min(...sphericalCoordinates.filter((point:Spherical)=> point.theta>0).map((point: Spherical)=> point.phi)); // Case where the box is above
            let minPhi2 = Math.min(...sphericalCoordinates.filter((point:Spherical)=> point.theta<0).map((point: Spherical)=> point.phi));
            phiAngle = Math.PI - (minPhi1 + minPhi2)
            phiDistance = new Box2(new Vector2(minPhi1, 0), new Vector2(minPhi2, -0)).distanceToPoint(new Vector2(Math.PI/2,0)); // Did not find an interval implementation in threeJS
            
          }
        }
        else {

          let maxPhi = Math.max(...sphericalCoordinates.map((point: Spherical)=> point.phi));
          let minPhi = Math.min(...sphericalCoordinates.map((point: Spherical)=> point.phi));
          phiAngle = maxPhi - minPhi;
          phiDistance = new Box2(new Vector2(minPhi, 0), new Vector2(maxPhi, 0)).distanceToPoint(new Vector2(Math.PI/2,0)); // Did not find an interval implementation in threeJS;
        //};*/

        //=================  Theta 3 and 4,  facing the box ================
        _localBox.getCenter(_vec3a);
        _vec3a.sub(cameraPosition);
        _vec3a.applyQuaternion(worldQuaternion.clone().conjugate()); 
        const boxCenterInCamera = _vec3a.clone(); // in camera coordinates

        const faceBoxQuaternion = new Quaternion;
        faceBoxQuaternion.setFromUnitVectors(boxCenterInCamera.clone().normalize(), new Vector3(0,0,-1)); // rotation from camera repere to facing box repere
 
        let maxTheta3 = Math.max(...facingSphericalCoordinates.map((point: Spherical)=> point.theta));
        let minTheta3 = Math.min(...facingSphericalCoordinates.map((point: Spherical)=> point.theta));
        let thetaAngle3 = maxTheta3 - minTheta3;
        let thetaDistance3 = Math.PI - Math.max(Math.abs(maxTheta3), Math.abs(minTheta3));
        /*_cameraXAxis.set(1,0,0);
    _cameraXAxis.applyQuaternion(worldQuaternion);
 */
        const newXaxis = new Vector3;
        newXaxis.set(1,0,0);
        newXaxis.applyQuaternion(faceBoxQuaternion.clone().conjugate()).applyQuaternion(worldQuaternion); //X axis looking at the box in world coordinates
        const isBoxAcrossTheta3HalfPlane: boolean = _localBox.intersectsPlane(new Plane(newXaxis,-newXaxis.dot(cameraPosition))) && (boxMinInCameraCoordinates.clone().applyQuaternion(faceBoxQuaternion).z < 0);

        if (isBoxAcrossTheta3HalfPlane){ 
          let maxTheta3Neg = Math.max(...facingSphericalCoordinates.filter((point: Spherical)=> point.theta<0).map((point: Spherical)=> point.theta));
          let minTheta3Pos = Math.min(...facingSphericalCoordinates.filter((point: Spherical)=> point.theta>0).map((point: Spherical)=> point.theta));  
          thetaAngle3 = 2*Math.PI - minTheta3Pos + maxTheta3Neg; 
          thetaDistance3 = 0;
        } else {
          if (faceDebug(bloup)){
            console.log("T3 - This SHOULD NOT HAPPPEN : isBoxAcrossTheta3HalfPlane", isBoxAcrossTheta3HalfPlane, "bloup :",bloup);
            console.log({newXaxis: newXaxis , boxCenterInCamera: boxCenterInCamera, boxCenterInCRot: boxCenterInCamera.clone().applyQuaternion(faceBoxQuaternion)});
            console.log("intersection : ", _localBox.intersectsPlane(new Plane(newXaxis,-newXaxis.dot(cameraPosition))));
            console.log("z < 0", boxMinInCameraCoordinates.clone().applyQuaternion(faceBoxQuaternion).z < 0);
            console.log("boxMinInCameraCoordinates facing box", boxMinInCameraCoordinates.clone().applyQuaternion(faceBoxQuaternion));
            console.log({faceBoxQuaternionConjug: faceBoxQuaternion.clone().conjugate()});
          }
        };



        let maxTheta4 = Math.max(...facingrotatedSphericalCoordinates.map((point: Spherical)=> point.theta));
        let minTheta4 = Math.min(...facingrotatedSphericalCoordinates.map((point: Spherical)=> point.theta));
        let thetaAngle4 = maxTheta4 - minTheta4;
        let thetaDistance4 = Math.PI - Math.max(Math.abs(maxTheta4), Math.abs(minTheta4));
        const newXaxis_rotated = new Vector3(1,0,0);
        newXaxis_rotated.applyQuaternion(quaternion90AroundZ.clone().conjugate()).applyQuaternion(faceBoxQuaternion.clone().conjugate()).applyQuaternion(worldQuaternion);
        const isBoxAcrossTheta4HalfPlane: boolean = _localBox.intersectsPlane(new Plane(newXaxis_rotated,-newXaxis_rotated.dot(cameraPosition))) && (boxMinInCameraCoordinates.clone().applyQuaternion(faceBoxQuaternion).applyQuaternion(quaternion90AroundZ).z < 0);
        if (isBoxAcrossTheta4HalfPlane){ 
//          console.log("T4 - This SHOULD ALWAYS HAPPPEN : isBoxAcrossTheta4HalfPlane", isBoxAcrossTheta4HalfPlane);
          let maxTheta4Neg = Math.max(...facingrotatedSphericalCoordinates.filter((point: Spherical)=> point.theta<0).map((point: Spherical)=> point.theta));
          let minTheta4Pos = Math.min(...facingrotatedSphericalCoordinates.filter((point: Spherical)=> point.theta>0).map((point: Spherical)=> point.theta));  
          thetaAngle4 = 2*Math.PI - minTheta4Pos + maxTheta4Neg; 
          thetaDistance4 = 0;
        } else {
//          if (faceDebug(bloup)){
            console.log("T4 - This SHOULD NOT HAPPPEN : isBoxAcrossTheta3HalfPlane", isBoxAcrossTheta3HalfPlane, "bloup :",bloup);
            console.log("intersection : ", _localBox.intersectsPlane(new Plane(newXaxis_rotated,-newXaxis_rotated.dot(cameraPosition))));
            console.log("z < 0", (boxMinInCameraCoordinates.clone().applyQuaternion(faceBoxQuaternion).applyQuaternion(quaternion90AroundZ).z < 0));
//          }
        }

        if (faceDebug(bloup)){
          console.log("maxTheta3 :", maxTheta3, " - minTheta3 : ", minTheta3, " - thetaAngle3 : ", thetaAngle3);
          console.log("maxTheta4 :", maxTheta4, " - minTheta4 : ", minTheta4, " - thetaAngle4 : ", thetaAngle4);
        }

        // ===========================


        //sphericalAngularArea = Math.abs(thetaAngle2 * thetaAngle) /// (4 * Math.PI**2); // We normalize to be closer to the previous kind of values provided by ndc/ncc
        sphericalAngularArea = Math.abs (thetaAngle3*thetaAngle4)

        sphericalAngularDistance = new Vector2(thetaDistance, thetaDistance2).length();        
        if (faceDebug(bloup)) {
//          console.log("angles",{bloup: bloup, thetaAngle2: thetaAngle2, thetaAngle: thetaAngle, phiDistance: phiDistance, thetaDistance, sphericalAngularDistance: sphericalAngularDistance});
       //   console.log("angles",{bloup: bloup,thetaDistance: thetaDistance,thetaDistance2: thetaDistance2, thetaAngle3: thetaAngle3, thetaAngle4: thetaAngle4});        }
        }
        
      } else{
        //Priority is maximal if camera is inside the bounding box
        console.log("inside the Box n° ", bloup.toString());
        sphericalDistanceWeight = 1;

      }

      //_localBox.getSize(_vec3a);
      _ndcBox.min.clampScalar(-1,1);
      _ndcBox.max.clampScalar(-1,1);
      _ndcBox.getSize(_vec3a);
      let visibleSize = (_vec3a.x *_vec3a.y)/4;
      const depthMod = Math.max(1-distance, 0.1);
      const angleMod = 1 - Math.abs(angle)/Math.PI;

      weights.push([model.ins.name.value, {distance, angle, depthMod, angleMod, visibleSize}]);

      const weight = depthMod*angleMod;
      

      ///======================== Spherical version===================================
      //const sphericalAngleMod = sphericalAngularArea // TODO here => faire une formule de poids propre
      const sphericalAngleMod = (1 - Math.abs(sphericalAngularDistance/Math.sqrt(Math.PI**2 + Math.PI**2)));
      let newWeight = depthMod * sphericalAngularArea * sphericalAngleMod
      // console.log("Spherical LOD : Distance modifier :", depthMod.toString());
      // console.log("Spherical LOD : Angular area :", sphericalAngularArea.toString());
      // console.log("Spherical LOD : Field of view modifier on angular area", sphericalFieldOfViewWeight.toString());
      //let sphericalWeight = depthMod * sphericalAngularArea ;
      
      //console.log("SphLOD n°", bloup.toString(), ":", {depthMod: depthMod, sphAngMod: sphericalAngleMod, sphAngArea: sphericalAngularArea,sphAngDistance: sphericalAngularDistance});
      console.log("SphLOD n°", bloup.toString(), ":", {newWeight: newWeight, previousWeigh: weight});

//      console.log("Spherical LOD : Weight :", sphericalWeight.toString(), "Previous LOD : Weight :", weight.toString());
      //// ==========================^^^^^^^^^^===================================

      //Upgrade only here
      let qualityRequest =  model.derivatives.select(EDerivativeUsage.Web3D, getQuality(model.ins.quality.value, visibleSize))?.data.quality;
      if(model.isLoading()) currently_loading++;
      return {model, clipped, weight, qualityRequest} as ModelDisplayState;
    })
    .sort((a, b)=> a.weight - b.weight) //Sort low weights first



    let downgrades = new Map<CVModel2, EDerivativeQuality>();
    /** Separate upgrade path. We compute uprgades first but apply them last */
    let upgrades = new Map<CVModel2, EDerivativeQuality>();
    let textureSize = 0;
    //Now we have a list of  best-fit quality requests.
    //We first compute how much texture space upgrading this would use
    //to know whether or not we'd want to downgrade some models
    let downgradable :ModelDisplayState[] = [];
    for(let item of collection){
      let current_quality = item.model.ins.quality.value;
      if(item.model.isLoading() && current_quality != item.qualityRequest && item.model.activeDerivative){
        // Opportunistically cancel any derivative we no longer want
        // Additionally, set the quality to the current derivative's value
        item.model.ins.quality.setValue(item.model.activeDerivative.data.quality);
        current_quality = item.model.activeDerivative.data.quality;
        currently_loading --;
      }
      
      if(current_quality < item.qualityRequest){
        //Upgrade models as requested
        upgrades.set(item.model, item.qualityRequest);
        current_quality = item.qualityRequest;
      }else if(item.qualityRequest < item.model.ins.quality.value){
        downgradable.push(item);
      }
      textureSize += getSize(item.model, current_quality);
    }


    //Now we decide what to downgrade

    for(let item of downgradable){
      /**Opportunistic downgrade :
       * Happens only as long as one of these conditions are met :
       * - we are near our max budget usage
       * - loading is reasonably idle
       * AND the model is either
       * - entirely clipped 
       * - two levels above the expected quality
       */
      if(
        /* Change this divider to allow us to downgrade further when idle, saving memory */
        textureSize < this._budget/2 
        /* We might allow more downloads to happen in parallel but there is not much performance gains to be expected */
        && 2 < (downgrades.size + upgrades.size + currently_loading) 
      ){
        break;
      }

      if(
        item.clipped
        || item.qualityRequest < item.model.ins.quality.value + 1
      ){
        downgrades.set(item.model, item.qualityRequest);
        textureSize += getSize(item.model, item.qualityRequest) - getSize(item.model, item.model.ins.quality.value);
      }
    }

    let normal_downgrades = downgrades.size;

    /**
     * Agressive downgrades
     * If we are over-budget, blindly downgrade everything that can be until we are not.
    */
    for(let item of downgradable){
      if(textureSize < this._budget ) break;
      if(downgrades.has(item.model)) continue;
      downgrades.set(item.model, item.qualityRequest);
      textureSize += getSize(item.model, item.qualityRequest) - getSize(item.model, item.model.ins.quality.value);
    }
    let hard_downgrades = downgrades.size - normal_downgrades;

    /**
     * Cancel upgrades if necessary
     * In some cases too many upgrades are scheduled at once (similarly sized items)
     * We want to prevent that if that would overload the system
     */
    for(let [item, q] of upgrades){
      if(textureSize < this._budget) break; //Run only if overbudget
      //We are SURE `q != 0` because otherwise it wouldn't have been pushed to the upgrades queue
      upgrades.delete(item);
      textureSize += getSize(item, q-1) - getSize(item, q);
    }

    /**"contingency" downgrades. 
     * Downgrade everything starting from the lower weights to one level _below_ what was requested
     * A well-made scene shouldn't get there but we _have_ to be able to handle this
     */
    for(let item of downgradable){
      if(textureSize < this._budget ) break;
      const q = item.model.derivatives.select(EDerivativeUsage.Web3D, Math.max(item.qualityRequest - 1, 0)).data.quality;
      downgrades.set(item.model, q);
      textureSize += getSize(item.model, q) - getSize(item.model, item.model.ins.quality.value);
    }
    
    /**
     * Apply the changes. 
     * We start with the downgrades in the order they were added
     * Then with the upgrades, starting with the higher-weighted ones
     */
    for(let [model, quality] of [...downgrades.entries(), ...[...upgrades.entries()].reverse()]){
      //We don't want to have too many models loading at once
      if(6 < currently_loading) break;
      const current = model.ins.quality.value;
      if(quality === current) continue;
      const bestMatchDerivative = model.derivatives.select(EDerivativeUsage.Web3D, quality);
      if(bestMatchDerivative && bestMatchDerivative.data.quality != current ){
        model.ins.quality.setValue(bestMatchDerivative.data.quality);
        currently_loading++;
      }
    }

    if(currently_loading != 0){
      const countQ = (q :EDerivativeQuality)=>collection.reduce((s, m)=>(s+((m.model.ins.quality.value === q)?1:0)), 0);
      console.debug(`models quality: [%d, %d, %d, %d]. loading %d models with %d/%d downgrades %s`, 
        countQ(EDerivativeQuality.High),
        countQ(EDerivativeQuality.Medium),
        countQ(EDerivativeQuality.Low),
        countQ(EDerivativeQuality.Thumb),
        currently_loading,
        normal_downgrades,
        hard_downgrades,
        (hard_downgrades != downgrades.size?`(${downgrades.size - normal_downgrades - hard_downgrades} forced downgrades)`:"")
      );
    }
    return 0 < downgrades.size;
  }
  
  fromData(data: ILOD)
    {
        data = data || {} as ILOD;

        this.ins.copyValues({
            enabled: !!data.enabled,
        });
    }

    toData(): ILOD
    {
        const ins = this.ins;
        const data: Partial<ILOD> = {};

        data.enabled = ins.enabled.value;
        
        return data as ILOD;
    }


}