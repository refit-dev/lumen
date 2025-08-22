"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

interface WebGLEarthProps {
  className?: string;
}

export default function WebGLEarth({ className }: WebGLEarthProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationIdRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;

    // Scene constants
    const SCENE_ANTIALIAS = true;
    const SCENE_ALPHA = true;

    const CAMERA_FOV = 23;
    const CAMERA_NEAR = 100;
    const CAMERA_FAR = 500;
    const CAMERA_X = 0; // Center camera horizontally
    const CAMERA_Y = 0; // Center camera vertically
    const CAMERA_Z = 180;

    const SPHERE_RADIUS = 30;
    const LATITUDE_COUNT = 80;
    const DOT_DENSITY = 0.85;
    const DOT_SIZE = 0.2;
    const DOT_COLOR = 0x424242; // Medium gray for good visibility

    // Utility functions
    const spherePointToUV = (
      dotCenter: THREE.Vector3,
      sphereCenter: THREE.Vector3
    ) => {
      const newVector = new THREE.Vector3();
      newVector.subVectors(sphereCenter, dotCenter).normalize();

      const uvX =
        1 - (0.5 + Math.atan2(newVector.z, newVector.x) / (2 * Math.PI));
      const uvY = 0.5 + Math.asin(newVector.y) / Math.PI;

      return new THREE.Vector2(uvX, uvY);
    };

    const sampleImage = (imageData: ImageData, uv: THREE.Vector2) => {
      const point =
        4 * Math.floor(uv.x * imageData.width) +
        Math.floor(uv.y * imageData.height) * (4 * imageData.width);

      return imageData.data.slice(point, point + 4);
    };

    const renderScene = (imageData: ImageData) => {
      // Define the renderer
      const renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: SCENE_ANTIALIAS,
        alpha: SCENE_ALPHA,
      });

      // Set initial size
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      renderer.setClearColor(0x000000, 0); // Transparent background

      // Set up camera
      const camera = new THREE.PerspectiveCamera(
        CAMERA_FOV,
        canvas.clientWidth / canvas.clientHeight,
        CAMERA_NEAR,
        CAMERA_FAR
      );

      // Set up orbit controls
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.enableZoom = false;
      controls.enablePan = false;

      // Position camera
      camera.position.set(CAMERA_X, CAMERA_Y, CAMERA_Z);
      controls.update();

      // Set up scene
      const scene = new THREE.Scene();
      // Keep background transparent for blending with landing page

      // Create dots
      const dotGeometries: THREE.CircleGeometry[] = [];
      const vector = new THREE.Vector3();

      for (let lat = 0; lat < LATITUDE_COUNT; lat += 1) {
        const radius =
          Math.cos((-90 + (180 / LATITUDE_COUNT) * lat) * (Math.PI / 180)) *
          SPHERE_RADIUS;
        const latitudeCircumference = radius * Math.PI * 2 * 2;
        const latitudeDotCount = Math.ceil(latitudeCircumference * DOT_DENSITY);

        for (let dot = 0; dot < latitudeDotCount; dot += 1) {
          const dotGeometry = new THREE.CircleGeometry(DOT_SIZE, 5);
          const phi = (Math.PI / LATITUDE_COUNT) * lat;
          const theta = ((2 * Math.PI) / latitudeDotCount) * dot;

          vector.setFromSphericalCoords(SPHERE_RADIUS, phi, theta);

          dotGeometry.lookAt(vector);
          dotGeometry.translate(vector.x, vector.y, vector.z);
          dotGeometry.computeBoundingSphere();

          const uv = spherePointToUV(
            dotGeometry.boundingSphere?.center || new THREE.Vector3(),
            new THREE.Vector3()
          );

          const sampledPixel = sampleImage(imageData, uv);

          if (sampledPixel[3]) {
            dotGeometries.push(dotGeometry);
          }
        }
      }

      // Only proceed if we have dots to display
      if (dotGeometries.length === 0) {
        console.warn("No dots created - check earth mask");
        return () => {};
      }

      // Merge geometries
      const mergedDotGeometries =
        BufferGeometryUtils.mergeGeometries(dotGeometries);

      // Create material and mesh with transparency for depth perception
      const dotMaterial = new THREE.MeshBasicMaterial({
        color: DOT_COLOR,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8, // More visible while keeping depth
      });

      const dotMesh = new THREE.Mesh(mergedDotGeometries, dotMaterial);

      // Tilt the Earth so its north-south axis lies in the screen plane
      dotMesh.rotation.x = 0.4; // ≈23° tilt to bring axis into screen plane

      scene.add(dotMesh);

      console.log(`Created earth with ${dotGeometries.length} dots`);

      // Animation loop
      let rotationY = 0;
      const animate = () => {
        controls.update();

        // Manual rotation around the Earth's tilted Y-axis
        rotationY += 0.001; // Much slower rotation speed
        dotMesh.rotation.y = rotationY;

        renderer.render(scene, camera);

        animationIdRef.current = requestAnimationFrame(animate);
      };

      animationIdRef.current = requestAnimationFrame(animate);

      // Handle resize
      const handleResize = () => {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;

        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };

      window.addEventListener("resize", handleResize);
      handleResize();

      return () => {
        window.removeEventListener("resize", handleResize);
        renderer.dispose();
        controls.dispose();
      };
    };

    // Load the actual Earth map image
    const imageLoader = new THREE.ImageLoader();

    const loadEarthImage = () => {
      return new Promise<ImageData>((resolve, reject) => {
        imageLoader.load(
          "/map.png", // Path to the map image in public folder
          (image) => {
            // Create an HTML canvas, get its context and draw the image on it
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = image.width;
            tempCanvas.height = image.height;

            const ctx = tempCanvas.getContext("2d");
            if (!ctx) {
              reject(new Error("Could not get canvas context"));
              return;
            }

            ctx.drawImage(image, 0, 0);

            // Read the image data from the canvas context
            const imageData = ctx.getImageData(0, 0, image.width, image.height);
            resolve(imageData);
          },
          undefined,
          (error) => {
            console.error("Failed to load Earth map image:", error);
            // Fallback to programmatic earth mask
            resolve(createFallbackEarthMask());
          }
        );
      });
    };

    // Fallback earth mask in case the image fails to load
    const createFallbackEarthMask = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      canvas.width = 512;
      canvas.height = 256;

      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(255, 255, 255, 255)";

      // Basic continent shapes as fallback
      ctx.fillRect(60, 80, 200, 120); // North America
      ctx.fillRect(160, 240, 80, 160); // South America
      ctx.fillRect(400, 90, 120, 80); // Europe
      ctx.fillRect(420, 160, 100, 200); // Africa
      ctx.fillRect(480, 60, 300, 120); // Asia
      ctx.fillRect(700, 330, 120, 80); // Australia

      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    };

    // Load image and render scene
    let cleanup: (() => void) | undefined;

    loadEarthImage()
      .then((imageData) => {
        cleanup = renderScene(imageData);
      })
      .catch((error) => {
        console.error("Error loading Earth image:", error);
      });

    return () => {
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
      if (cleanup) {
        cleanup();
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
      }}
    />
  );
}
