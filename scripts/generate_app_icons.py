import os
from PIL import Image, ImageDraw

src_path = r"C:\Users\Vicenzzo\.gemini\antigravity-ide\brain\8f184e0d-4690-4c12-87e2-da7ab6f5a1a1\.user_uploaded\media_1787007835756.jpg"

if not os.path.exists(src_path):
    raise FileNotFoundError(f"Source image not found: {src_path}")

img = Image.open(src_path).convert("RGBA")

# Sphere center & radius in 1024x1024 source
cx, cy = 512, 498
r = 246  # Outer radius of the sphere figure

# Create 4x supersampled anti-aliased alpha mask
scale = 4
mask_size = (img.width * scale, img.height * scale)
mask = Image.new("L", mask_size, 0)
draw = ImageDraw.Draw(mask)

mcx, mcy = cx * scale, cy * scale
mr = r * scale
draw.ellipse([mcx - mr, mcy - mr, mcx + mr, mcy + mr], fill=255)

# Downscale mask with Lanczos for subpixel-smooth edge
mask = mask.resize(img.size, Image.Resampling.LANCZOS)
img.putalpha(mask)

# Crop tightly to the sphere with 5% aesthetic margin
pad = int(r * 0.06)
box = (cx - r - pad, cy - r - pad, cx + r + pad, cy + r + pad)
cropped_sphere = img.crop(box)

# Base 512x512 high-resolution transparent master
master_img = cropped_sphere.resize((512, 512), Image.Resampling.LANCZOS)

# Target icon files and sizes
icons_to_generate = {
    # Tauri bundle icons
    r"src-tauri\icons\icon.png": (512, 512),
    r"src-tauri\icons\32x32.png": (32, 32),
    r"src-tauri\icons\128x128.png": (128, 128),
    r"src-tauri\icons\128x128@2x.png": (256, 256),
    r"src-tauri\icons\Square30x30Logo.png": (30, 30),
    r"src-tauri\icons\Square44x44Logo.png": (44, 44),
    r"src-tauri\icons\Square71x71Logo.png": (71, 71),
    r"src-tauri\icons\Square89x89Logo.png": (89, 89),
    r"src-tauri\icons\Square107x107Logo.png": (107, 107),
    r"src-tauri\icons\Square142x142Logo.png": (142, 142),
    r"src-tauri\icons\Square150x150Logo.png": (150, 150),
    r"src-tauri\icons\Square284x284Logo.png": (284, 284),
    r"src-tauri\icons\Square310x310Logo.png": (310, 310),
    r"src-tauri\icons\StoreLogo.png": (50, 50),
    
    # Web / Frontend Assets
    r"public\logo.png": (512, 512),
    r"public\favicon.png": (64, 64),
    r"src\assets\logo.png": (512, 512),
    
    # Binary resources
    r"distributable\binaries\icon.png": (256, 256),
    r"src-tauri\binaries\icon.png": (256, 256),
}

# Generate PNGs
for rel_path, size in icons_to_generate.items():
    full_path = os.path.join(os.getcwd(), rel_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    resized = master_img.resize(size, Image.Resampling.LANCZOS)
    resized.save(full_path, "PNG", optimize=True)
    print(f"Generated transparent: {rel_path} ({size[0]}x{size[1]})")

# Generate multi-resolution .ico files
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ico_paths = [
    r"src-tauri\icons\icon.ico",
    r"distributable\resources\icon.ico",
    r"public\favicon.ico",
]

for rel_ico in ico_paths:
    full_ico = os.path.join(os.getcwd(), rel_ico)
    os.makedirs(os.path.dirname(full_ico), exist_ok=True)
    master_img.save(full_ico, format="ICO", sizes=ico_sizes)
    print(f"Generated transparent ICO: {rel_ico}")

print("All transparent icons successfully generated!")
