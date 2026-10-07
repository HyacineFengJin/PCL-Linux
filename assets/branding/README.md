# PCL RH 图标

`pcl-rh-source.png` 是项目采用的原始图标，主要美术由 GPT 制作。
`rh-mark.svg` 沿用其连写 RH 字形，用于蓝色标题栏。
应用、关于页和更新页共用 `../pcl-rh.png`。

从原图重新生成应用图标：

```sh
apps/desktop/node_modules/.bin/tauri icon assets/branding/pcl-rh-source.png -p 256 -o assets/branding/generated
mv assets/branding/generated/256x256.png assets/pcl-rh.png
rmdir assets/branding/generated
./prepare-icon.sh
```
