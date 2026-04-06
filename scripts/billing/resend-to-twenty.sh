#!/bin/bash

echo "🚀 Renvoi des événements price.created vers le webhook Twenty"
echo ""
echo "⚠️  Assurez-vous que 'stripe listen --live' est lancé dans un autre terminal !"
echo ""
sleep 3

WEBHOOK_ID="we_1SroHkRgvfRggzUNXFl1GuMV"

echo "📨 Envoi de l'événement Enterprise yearly v4..."
stripe events resend evt_1SsVEORgvfRggzUNUWxyLW0D --webhook-endpoint $WEBHOOK_ID --live 2>&1
echo ""
sleep 2

echo "📨 Envoi de l'événement Enterprise monthly v4..."
stripe events resend evt_1SsVENRgvfRggzUNsky25OuO --webhook-endpoint $WEBHOOK_ID --live 2>&1
echo ""
sleep 2

echo "📨 Envoi de l'événement Pro yearly v1..."
stripe events resend evt_1SoXkcRgvfRggzUNx9a2wQnL --webhook-endpoint $WEBHOOK_ID --live 2>&1
echo ""
sleep 2

echo "📨 Envoi de l'événement Pro monthly v1..."
stripe events resend evt_1SoXkSRgvfRggzUNSEvy99lP --webhook-endpoint $WEBHOOK_ID --live 2>&1
echo ""

echo "✅ Tous les événements ont été renvoyés !"
echo ""
echo "🔍 Vérification dans Twenty dans 3 secondes..."
sleep 3
