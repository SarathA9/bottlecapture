# Bottle water-mass model

Predicts grams of water in a bottle from one photo. Trained only on your BottleCapture data.

## What it does
- Starts from an ImageNet-pretrained EfficientNet-B0 (or ConvNeXt-Tiny) and fine-tunes it to output grams.
- Keeps every photo whole (pads to a square instead of cropping), so the base and the water line are never cut off.
- Light augmentation: small crops, mirror, small rotation, colour changes.
- Tests fairly: all photos of one fill stay together. Cross-validation holds out whole fills; the final check uses whole sessions you marked "validation" in the app.
- Never reads the professor's data during training.

## Run it on the OTH GPU workstation (DC-107)
Turn on the OTH VPN first. Then, in PowerShell on your laptop:
```
# 1. Copy the dataset (photos AND .json files) to the workstation
scp -r "C:\Users\sarat\Documents\Bottle Mass\BottleCapture Dataset" s.adukkadukkam@oth-aw.de@ki-029.oth-aw.de:~/

# 2. Log in
ssh s.adukkadukkam@oth-aw.de@ki-029.oth-aw.de
```
On the workstation:
```
git clone https://github.com/SarathA9/bottlecapture.git
bash bottlecapture/ml/run_on_workstation.sh "$HOME/BottleCapture Dataset"
tail -f ~/bottle_runs/train.log        # Ctrl+C stops watching, not training
```
If ki-029 is busy or down, use ki-030, ki-031 or ki-032.

## Run it on Google Colab (free GPU)
1. Zip your `BottleCapture Dataset` folder (photos + .json files) and upload it to Google Drive.
2. In Colab: Runtime → Change runtime type → GPU.
3. Run:
```
from google.colab import drive; drive.mount('/content/drive')
!unzip -q "/content/drive/MyDrive/BottleCapture Dataset.zip" -d /content/
# upload the bottle_model folder to Drive too, then:
%cd "/content/drive/MyDrive/bottle_model"
!pip install -r requirements.txt
!python train.py --data "/content/BottleCapture Dataset" --cv 5 --out runs/cv     # honest check first
!python train.py --data "/content/BottleCapture Dataset" --out runs/final        # final model
```
4. Leave out a fill with a wrong label: `--exclude-fill B02_I01_S01_d10b6bb3_F01`.

## Reading the numbers
- **MAE per photo**: average error in grams. Compare it with the line "always guessing the average would score …". A model is only useful when it clearly beats that.
- **MAE of fill average**: error after averaging the photos of one fill.
- With only a dozen fills of one bottle, expect the model to be close to guessing the average. It needs many more fills and all bottles.

## The professor's data
Use `evaluate.py` on it once, at the very end, and only if you are allowed to. Do not change the model or settings because of that score; then it would no longer be a fair test.
```
python evaluate.py --model runs/final/model.pt --images "/path/to/professor photos" --out predictions.csv
```
