const int pirPin = 2;
const int buzzerPin = 3;

void setup() {
  pinMode(pirPin, INPUT);
  pinMode(buzzerPin, OUTPUT);
}

void loop() {
  int motion = digitalRead(pirPin);

  if (motion == HIGH) {
    tone(buzzerPin, 1000); // beep
  } else {
    noTone(buzzerPin); // stop
  }
}